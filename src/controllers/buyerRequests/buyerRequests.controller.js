import BuyerRequest from "../../models/BuyerRequest.model.js";
import BuyerRequestResponse from "../../models/BuyerRequestResponse.model.js";
import Buyer from "../../models/Buyer.model.js";
import Store from "../../models/Store.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { matchBuyerRequestToVendors } from "../../services/matchingClient.service.js";
import { sendSms } from "../../services/sendchamp.service.js";
import { notifyUser } from "../../services/pushNotification.service.js";

// ── POST /api/buyer-requests ────────────────────────────────────────────────
// Auth-gated (verifyBuyerAuth). Regardless of whether the confirmation SMS
// succeeds, a request that DOES have matched vendors must still be created —
// spec §29/§53, request creation must still succeed on an SMS failure.
//
// 2026-08-16: reverses spec §14's original "do not reject the request" rule
// for the ZERO-match case specifically. That rule was written when "reach
// out to businesses" was assumed to always reach someone; in practice, this
// tool only ever fires after searchProducts AND searchStores already came up
// empty against the same vendor corpus this matching call also searches —
// so a zero match here is common, not an edge case. Persisting a request no
// vendor will ever see turned "I've reached out to businesses for you" into
// a false promise. Now: no match, no request — the caller (createBuyerRequestTool)
// falls back to surfacing Google Places instead of a hollow confirmation.
// Retroactive matching (a new/edited vendor matching later) remains the
// documented V2 follow-up, unaffected by this — it would need reviving
// unmatched requests, not just skipping their creation.
export async function createRequest(req, res, next) {
  try {
    const { description, imageUrl, location } = req.body ?? {};
    if (typeof description !== "string" || !description.trim()) {
      return next(new AppError("A description is required.", 400));
    }

    const buyer = await Buyer.findById(req.buyer.buyerId);
    if (!buyer) return next(new AppError("Buyer not found.", 404));

    // Prefer a location explicitly sent with this request; fall back to the
    // buyer's saved location (set at verify-otp time or since); nationwide
    // matching if neither exists — mirrors the existing buyer-search
    // fallback chain (resolveSearchLocation) rather than inventing a new one.
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
    } else if (buyer.location?.coordinates?.length === 2) {
      [lng, lat] = buyer.location.coordinates;
      geo = buyer.location;
    }

    const matchedVendorIds = await matchBuyerRequestToVendors({
      queryText: description.trim(),
      lat,
      lng,
      imageUrl: typeof imageUrl === "string" ? imageUrl : undefined,
    });

    if (matchedVendorIds.length === 0) {
      return res.status(200).json({ success: true, data: { created: false } });
    }

    const request = await BuyerRequest.create({
      buyerId: buyer._id,
      description: description.trim(),
      imageUrl: typeof imageUrl === "string" ? imageUrl : null,
      ...(geo && { location: geo }),
      area: buyer.area,
      state: buyer.state,
      matchedVendorIds,
    });

    // Best-effort, both of these — never let either failure roll back the
    // request that was just created (spec §29/§53 for SMS; matched vendors
    // not hearing about it immediately is recoverable, the request still
    // exists for them to find via their own Buyer Requests list).
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
    // only `_id` (verified against the installed mongoose version — this
    // isn't a lean-vs-hydrated thing) — every caller of this endpoint reads
    // `request.id` (the "View request" link, the AI tool's requestId), so
    // without this explicit map it comes back undefined downstream.
    res.status(201).json({
      success: true,
      data: { created: true, request: { ...request.toObject(), id: String(request._id) } },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── GET /api/buyer-requests/my ──────────────────────────────────────────────
export async function getMyRequests(req, res, next) {
  try {
    const requests = await BuyerRequest.find({ buyerId: req.buyer.buyerId })
      .sort({ createdAt: -1 })
      .lean();
    // .lean() returns plain objects — no `id` virtual (that's only computed
    // on real Documents), just the raw `_id`. Without this, every request
    // card's link (`/buyer/requests/${request.id}`) resolves to
    // /buyer/requests/undefined. Mirrors auth.js login's own explicit
    // `id: user._id` for the same reason.
    res.status(200).json({
      success: true,
      data: { requests: requests.map((r) => ({ ...r, id: String(r._id) })) },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

async function loadOwnRequestOr404(req, next) {
  const request = await BuyerRequest.findById(req.params.id);
  if (!request) {
    next(new AppError("Request not found.", 404));
    return null;
  }
  if (String(request.buyerId) !== String(req.buyer.buyerId)) {
    // 404, not 403 — don't confirm to a caller that a request with this id
    // exists and just isn't theirs (spec §46: "No user should be able to
    // access another user's private request information").
    next(new AppError("Request not found.", 404));
    return null;
  }
  return request;
}

// ── GET /api/buyer-requests/:id ─────────────────────────────────────────────
export async function getRequest(req, res, next) {
  try {
    const request = await loadOwnRequestOr404(req, next);
    if (!request) return;
    // See createRequest's own comment — a hydrated Document's default JSON
    // form only has `_id`, not `id`; this page reads `request.id` for the
    // WhatsApp lead-billing click, so without this it silently sends
    // `undefined` as the source id.
    res.status(200).json({
      success: true,
      data: { request: { ...request.toObject(), id: String(request._id) } },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── PATCH /api/buyer-requests/:id/cancel ────────────────────────────────────
export async function cancelRequest(req, res, next) {
  try {
    const request = await loadOwnRequestOr404(req, next);
    if (!request) return;

    if (request.status !== "active") {
      return next(new AppError(`Cannot cancel a ${request.status} request.`, 400));
    }

    request.status = "cancelled";
    await request.save();

    res.status(200).json({
      success: true,
      data: { request: { ...request.toObject(), id: String(request._id) } },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── GET /api/buyer-requests/:id/responses ───────────────────────────────────
// Returns each vendor's response plus enough store context (name, whatsapp,
// handle) for the buyer to read and decide who to chat — spec §26. The
// actual "Chat on WhatsApp" billing click stays a separate, existing
// endpoint (POST /api/search/lead, source: "buyer_request") — this endpoint
// only ever reads and never charges anything.
export async function getResponses(req, res, next) {
  try {
    const request = await loadOwnRequestOr404(req, next);
    if (!request) return;

    const responses = await BuyerRequestResponse.find({ requestId: request._id })
      .sort({ createdAt: 1 })
      .lean();

    const vendorIds = responses.map((r) => r.vendorId);
    const stores = await Store.find({ vendorId: { $in: vendorIds } })
      .select("vendorId name whatsapp handle")
      .lean();
    const storeByVendorId = new Map(stores.map((s) => [String(s.vendorId), s]));

    const enriched = responses.map((r) => ({
      ...r,
      id: String(r._id), // .lean() — see getMyRequests's comment above
      vendor: storeByVendorId.get(String(r.vendorId)) ?? null,
    }));

    res.status(200).json({ success: true, data: { responses: enriched } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
