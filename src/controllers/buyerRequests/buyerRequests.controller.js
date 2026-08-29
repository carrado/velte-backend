import BuyerRequest from "../../models/BuyerRequest.model.js";
import Buyer from "../../models/Buyer.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { matchBuyerRequestToVendors } from "../../services/matchingClient.service.js";
import { sendSms } from "../../services/sendchamp.service.js";
import { notifyUser } from "../../services/pushNotification.service.js";

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
    const { description, imageUrl, location, name, matchQuery } = req.body ?? {};
    if (typeof description !== "string" || !description.trim()) {
      return next(new AppError("A description is required.", 400));
    }
    if (typeof name !== "string" || !name.trim()) {
      return next(new AppError("A name is required.", 400));
    }

    // Two ways to get here since 2026-08-27 (see
    // requireBuyerOrVerifiedPhone): a signed-in buyer, or someone with no
    // account who just proved a phone number for this one request. The
    // middleware guarantees at least one, so this can't come out empty.
    //
    // The phone is taken from the SESSION buyer when there is one, and only
    // otherwise from the proof — a signed-in buyer's own verified number is
    // the more authoritative of the two, and it's the one the "use this
    // number?" confirmation put in front of them.
    let buyer = null;
    if (req.buyer?.buyerId) {
      buyer = await Buyer.findById(req.buyer.buyerId);
      if (!buyer) return next(new AppError("Buyer not found.", 404));
    }
    const buyerPhone = buyer?.phone || req.verifiedPhone || null;
    if (!buyerPhone) {
      // Belt to the middleware's braces: a signed-in buyer with no verified
      // number yet would otherwise create a request no vendor can reply to.
      return next(new AppError("A verified phone number is required.", 400));
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
      imageUrl: typeof imageUrl === "string" ? imageUrl : null,
      ...(geo && { location: geo }),
      matchedVendorIds,
    });

    // Best-effort, both of these — never let either failure roll back the
    // request that was just created.
    sendSms(
      buyer.phone,
      "Velte: Your request has been received. We'll notify you when vendors respond.",
    ).catch((err) => {
      console.error(`[buyerRequests] confirmation SMS failed for request ${request._id}:`, err.message);
    });

    const preview =
      description.trim().length > 80
        ? `${description.trim().slice(0, 80)}…`
        : description.trim();
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
      data: { created: true, request: { ...request.toObject(), id: String(request._id) } },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
