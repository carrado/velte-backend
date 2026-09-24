import BuyerRequest from "../../models/BuyerRequest.model.js";
import BuyerRequestResponse from "../../models/BuyerRequestResponse.model.js";
import Buyer from "../../models/Buyer.model.js";
import User from "../../models/Users.js";
import Store from "../../models/Store.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { matchBuyerRequestToVendors } from "../../services/matchingClient.service.js";
import { sendSms } from "../../services/sendchamp.service.js";
import { notifyUser } from "../../services/pushNotification.service.js";
import { textMatchedVendors } from "../../helpers/vendorRequestSms.js";

// ── POST /api/buyer-requests ────────────────────────────────────────────────
// Auth-gated (verifyBuyerAuth). Regardless of whether the confirmation SMS
// succeeds, a request that DOES have matched vendors must still be created —
// an SMS failure must never roll back the request itself.
//
// No match, no request: this tool only ever fires after searchProducts AND
// searchStores already came up empty against the same vendor corpus this
// matching call also searches, so a zero match here is common, not an edge
// case. Persisting a request no vendor will ever see would turn "I've
// reached out to businesses for you" into a false promise — the caller
// (createBuyerRequestTool) falls back to surfacing Google Places instead.
export async function createRequest(req, res, next) {
  try {
    const { description, imageUrl, location, name, matchQuery, budgetKobo } =
      req.body ?? {};
    if (typeof description !== "string" || !description.trim()) {
      return next(new AppError("A description is required.", 400));
    }
    if (typeof name !== "string" || !name.trim()) {
      return next(new AppError("A name is required.", 400));
    }

    // Absent is fine and common — the capture step lets a buyer skip it. What
    // is not fine is a present-but-nonsense value, because that becomes a
    // number vendors price against. Rejected rather than coerced to null: a
    // budget silently dropped is worse than an error the buyer can correct,
    // since neither they nor the vendor would ever know it went missing.
    let budget = null;
    if (budgetKobo !== undefined && budgetKobo !== null) {
      if (
        typeof budgetKobo !== "number" ||
        !Number.isFinite(budgetKobo) ||
        budgetKobo < 0
      ) {
        return next(new AppError("Budget must be a positive amount.", 400));
      }
      budget = Math.round(budgetKobo);
    }

    // One way to get here since 2026-08-29: a signed-in buyer, guaranteed by
    // verifyBuyerAuth on the route. The `phoneToken` path — someone with no
    // account who had just proved a number for this one request — is gone.
    const buyer = await Buyer.findById(req.buyer.buyerId);
    if (!buyer) return next(new AppError("Buyer not found.", 404));

    // Their own PROVEN number. `phoneVerified` is checked rather than
    // trusting `phone` to be non-null — and the reason changed on 2026-09-03
    // without the check changing. It used to be that vendors received this
    // number, so an unproven one was a lead nobody could follow. Vendors never
    // receive it now; what an unproven number would do instead is point our
    // own "businesses answered" SMS at a stranger who never asked for it.
    const buyerPhone = buyer.phoneVerified ? buyer.phone : null;
    if (!buyerPhone) {
      // Returned directly rather than through AppError, which carries only
      // (message, statusCode); the frontend branches on `code`, not on the
      // wording. The CODE is the point: this is the ordinary next step in
      // the flow (signed in, number not proven yet), and the frontend opens
      // its phone capture on it instead of showing an error. Branch on the
      // CODE, never on the wording.
      return res.status(403).json({
        success: false,
        message: "Verify your phone number to send this request.",
        code: "phone_required",
      });
    }

    // Only ever the location explicitly granted for THIS request — buyers
    // have no saved/remembered location to fall back to (2026-08-18, see
    // Buyer.model.js's own comment). No location this time just means no
    // geo filtering on the match below, and the vendor-facing detail page
    // shows "N/A" instead of guessing.
    let geo;
    let lat, lng;
    if (
      location &&
      typeof location.lat === "number" &&
      typeof location.lng === "number"
    ) {
      lat = location.lat;
      lng = location.lng;
      geo = { type: "Point", coordinates: [lng, lat] };
    }

    // MATCH ON BOTH TERMS, not just the description (2026-08-26).
    //
    // Reported live: Velte offered to reach out ("I found a business whose
    // sector fits 'heels size 40'"), asked the buyer for their name, and
    // then answered "Couldn't find anyone on Velte to contact for this
    // right now." Both statements were true — they were just about
    // DIFFERENT TEXT. The offer is only ever made after the AI service
    // confirms a real sector match for the short search term ("heels size
    // 40"); this creation step then threw that term away and re-matched on
    // `description`, the model's long vendor-facing sentence ("Hi, I'm
    // looking for a pair of size 40 heels..."), which ranks quite
    // differently. The `matchQuery` field carrying the exact term that
    // justified the offer was already being sent from the search route and
    // silently ignored here.
    //
    // Both are tried and the results are UNIONED rather than picking one:
    // matchQuery is the term a vendor was already proven to match, and the
    // description can legitimately reach vendors the short term misses.
    // That direction of error is the one the spec asks for (§14, "don't
    // reject/under-match, preserve the demand").
    const matchTerms = [
      typeof matchQuery === "string" && matchQuery.trim()
        ? matchQuery.trim()
        : null,
      description.trim(),
    ].filter(Boolean);

    const matchLists = await Promise.all(
      matchTerms.map((queryText) =>
        matchBuyerRequestToVendors({
          queryText,
          lat,
          lng,
          // The photo belongs to the buyer's actual need, so it only ever
          // rides along with the description — pairing it with the short
          // term would be matching an image against a label it was never
          // taken for.
          imageUrl:
            queryText === description.trim() && typeof imageUrl === "string"
              ? imageUrl
              : undefined,
        }),
      ),
    );
    const matchedVendorIds = [...new Set(matchLists.flat())];

    if (matchedVendorIds.length === 0) {
      return res.status(200).json({ success: true, data: { created: false } });
    }

    const request = await BuyerRequest.create({
      // Null for an anonymous buyer — the request stands entirely on its own
      // snapshot (name + phone below), which is where a buyer's details have
      // always lived anyway. See BuyerRequest.model.js.
      buyerId: buyer?._id ?? null,
      buyerName: name.trim(),
      buyerPhone,
      description: description.trim(),
      budgetKobo: budget,
      imageUrl: typeof imageUrl === "string" ? imageUrl : null,
      ...(geo && { location: geo }),
      matchedVendorIds,
    });

    // Best-effort, all of these — never let any failure roll back the
    // request that was just created.
    sendSms(
      buyer.phone,
      "Velte: Your request has been received. We'll notify you when vendors respond.",
    ).catch((err) => {
      console.error(
        `[buyerRequests] confirmation SMS failed for request ${request._id}:`,
        err.message,
      );
    });

    const preview =
      description.trim().length > 80
        ? `${description.trim().slice(0, 80)}…`
        : description.trim();

    // Every matched vendor also gets an SMS with a short link to this
    // request — see helpers/vendorRequestSms.js for why, and its trade-offs.
    textMatchedVendors({ request, vendorIds: matchedVendorIds }).catch(
      (err) => {
        console.error(
          `[buyerRequests] vendor SMS batch failed for request ${request._id}:`,
          err?.message ?? err,
        );
      },
    );

    for (const vendorId of matchedVendorIds) {
      notifyUser(vendorId, {
        type: "buyer-request",
        title: "New Buyer Request",
        body: `Someone near you is looking for: ${preview}`,
        url: `/${vendorId}/buyer-requests/${request._id}`,
        tag: "buyer-request",
      }).catch((err) => {
        console.error(
          `[buyerRequests] vendor notify failed for ${vendorId}, request ${request._id}:`,
          err.message,
        );
      });
    }

    // Mongoose's default JSON serialization drops the `id` virtual and keeps
    // only `_id` — the AI tool reads `request.id`, so without this explicit
    // map it comes back undefined downstream.
    res.status(201).json({
      success: true,
      data: {
        created: true,
        request: { ...request.toObject(), id: String(request._id) },
      },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── GET /api/buyer-requests/mine ────────────────────────────────────────────
// The buyer's own view of what they've sent out (2026-08-30). Reverses the
// 2026-08-18 note on buyerRequests.routes.js that there is no buyer inbox to
// read one from: that was true while buyers had no accounts, and posting a
// request has required one since 2026-08-29.
//
// The ONE thing this has to answer is "did anything come of it" — so the
// vendors who ACCEPTED are resolved and returned with each request, not just
// counted. Accepted, specifically, never merely "responded": a decline costs
// the vendor nothing and releases no contact detail, so counting it would
// inflate the only number on this page the buyer actually acts on.
// `responseCount` on the request itself is the raw decision tally (both
// kinds) and is deliberately NOT surfaced as-is for that reason.
//
// Contact detail flows the other way here than everywhere else in this file:
// the vendor already paid for this lead (decideOnRequest debits the wallet
// before this vendor can ever appear in `responders`), so handing the buyer
// the store they can walk into isn't a leak — it's the thing they were
// promised. Only the public store identity goes out: handle, name, avatar,
// area. Never a phone; the vendor has the buyer's number and reaches out
// over WhatsApp, and the store page carries its own contact button.
export async function listMyRequests(req, res, next) {
  try {
    const requests = await BuyerRequest.find({ buyerId: req.buyer.buyerId })
      .sort({ createdAt: -1 })
      // A cap, not pagination — a buyer with more than 50 requests behind
      // them is not a case that exists yet, and an unbounded find is the
      // kind of thing that only becomes a problem in production.
      .limit(50)
      // buyerPhone is the buyer's OWN number here, so there is nothing to
      // gate — but it has no business in a page payload either.
      .select("-buyerPhone")
      .lean();

    if (requests.length === 0) {
      return res.status(200).json({ success: true, data: { requests: [] } });
    }

    const accepted = await BuyerRequestResponse.find({
      requestId: { $in: requests.map((r) => r._id) },
      decision: "accepted",
    })
      .select("requestId vendorId createdAt priceKobo leadTimeDays note")
      .sort({ createdAt: 1 })
      .lean();

    const vendorIds = [...new Set(accepted.map((r) => String(r.vendorId)))];
    // Two lookups rather than a populate: the display name lives on User and
    // the public URL lives on Store, and a vendor can legitimately have no
    // Store row yet (it's created lazily on first dashboard visit) — which
    // must show the vendor without a link, not drop them from the list.
    const [vendors, stores] = await Promise.all([
      User.find({ _id: { $in: vendorIds } })
        .select("name company.name avatar area state")
        .lean(),
      Store.find({ vendorId: { $in: vendorIds } })
        .select("vendorId handle name")
        .lean(),
    ]);

    const vendorById = new Map(vendors.map((v) => [String(v._id), v]));
    const storeByVendorId = new Map(stores.map((s) => [String(s.vendorId), s]));

    const respondersByRequestId = new Map();
    for (const response of accepted) {
      const vendorId = String(response.vendorId);
      const vendor = vendorById.get(vendorId);
      // A deleted vendor account leaves its response row behind. Skipping it
      // keeps the count honest — a card saying "1 business accepted" with
      // nothing to show under it is worse than saying none did.
      if (!vendor) continue;
      const store = storeByVendorId.get(vendorId);
      const key = String(response.requestId);
      const list = respondersByRequestId.get(key) ?? [];
      list.push({
        vendorId,
        name: store?.name || vendor.company?.name || vendor.name,
        avatar: vendor.avatar ?? null,
        storeHandle: store?.handle ?? null,
        area: vendor.area ?? null,
        state: vendor.state ?? null,
        respondedAt: response.createdAt,
        // The quote (2026-09-03). Null throughout for a vendor who accepted
        // without naming terms — the comparison ranks whoever quoted and
        // lists the rest underneath, rather than treating "didn't say" as a
        // worse offer than one that was actually made.
        priceKobo: response.priceKobo ?? null,
        leadTimeDays: response.leadTimeDays ?? null,
        note: response.note ?? null,
      });
      respondersByRequestId.set(key, list);
    }

    // Derived, not read straight off the document: expiry is swept by a cron
    // (jobs/buyerRequestExpiry.job.js), so between sweeps a request can sit
    // at status "active" with an expiresAt already in the past — which the
    // buyer would read as "still out there, 0 replies" for as long as the
    // gap lasts. The stored status stays authoritative for everything else;
    // this only ever ages "active" forward.
    const now = Date.now();
    const payload = requests.map((r) => {
      const responders = respondersByRequestId.get(String(r._id)) ?? [];
      return {
        ...r,
        id: String(r._id), // .lean() drops the `id` virtual
        status:
          r.status === "active" && new Date(r.expiresAt).getTime() <= now
            ? "expired"
            : r.status,
        matchedVendorCount: r.matchedVendorIds?.length ?? 0,
        // Derived from what is actually being SHOWN, not read off the
        // document's own acceptedCount — a responder whose vendor account was
        // deleted is skipped above, and a card saying "2 businesses accepted"
        // above one row would be wrong in the direction that matters.
        acceptedCount: responders.length,
        quotedCount: responders.filter((v) => v.priceKobo != null).length,
        responders,
      };
    });

    // matchedVendorIds is a list of who was contacted on the buyer's behalf —
    // a buyer has no use for the ids themselves, and it's the vendor network
    // laid bare. The count above is what the page shows.
    for (const r of payload) delete r.matchedVendorIds;

    res.status(200).json({ success: true, data: { requests: payload } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
