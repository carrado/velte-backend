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
    const { description, imageUrl, location, name } = req.body ?? {};
    if (typeof description !== "string" || !description.trim()) {
      return next(new AppError("A description is required.", 400));
    }
    if (typeof name !== "string" || !name.trim()) {
      return next(new AppError("A name is required.", 400));
    }

    const buyer = await Buyer.findById(req.buyer.buyerId);
    if (!buyer) return next(new AppError("Buyer not found.", 404));

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
      buyerName: name.trim(),
      buyerPhone: buyer.phone,
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
