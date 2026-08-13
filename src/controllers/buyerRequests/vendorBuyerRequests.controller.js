import BuyerRequest from "../../models/BuyerRequest.model.js";
import BuyerRequestResponse from "../../models/BuyerRequestResponse.model.js";
import Store from "../../models/Store.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { notifyBuyer } from "../../services/buyerNotification.service.js";

// ── GET /api/vendor/buyer-requests ──────────────────────────────────────────
// Only requests this vendor was actually matched to (spec §17: "Do not
// expose every irrelevant request to every vendor") — matching itself
// already happened at request-creation time via the staffly-ai-backend call,
// this just filters by the stored result.
export async function listMatchedRequests(req, res, next) {
  try {
    const vendorId = req.user.userId;
    const requests = await BuyerRequest.find({
      matchedVendorIds: vendorId,
      status: "active",
    })
      .sort({ createdAt: -1 })
      .lean();

    const requestIds = requests.map((r) => r._id);
    const ownResponses = await BuyerRequestResponse.find({
      requestId: { $in: requestIds },
      vendorId,
    })
      .select("requestId")
      .lean();
    const respondedIds = new Set(ownResponses.map((r) => String(r.requestId)));

    const withFlag = requests.map((r) => ({
      ...r,
      id: String(r._id), // .lean() drops the `id` virtual — see the
      // buyer-side getMyRequests's comment; without this every card link
      // (`/${vendorId}/buyer-requests/${request.id}`) is .../undefined.
      alreadyResponded: respondedIds.has(String(r._id)),
    }));

    res.status(200).json({ success: true, data: { requests: withFlag } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

async function loadMatchedRequestOr404(req, next) {
  const request = await BuyerRequest.findById(req.params.id);
  if (!request || !request.matchedVendorIds.some((id) => String(id) === String(req.user.userId))) {
    // 404, not 403 — same reasoning as the buyer-side controller: don't
    // confirm a request exists to a vendor it was never matched to.
    next(new AppError("Request not found.", 404));
    return null;
  }
  return request;
}

// ── GET /api/vendor/buyer-requests/:id ──────────────────────────────────────
export async function getRequestDetail(req, res, next) {
  try {
    const request = await loadMatchedRequestOr404(req, next);
    if (!request) return;
    res.status(200).json({ success: true, data: { request } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── POST /api/vendor/buyer-requests/:id/respond ─────────────────────────────
// Writes the vendor's text response. Deliberately NOT a billing event — per
// the confirmed design (spec §62.1), the charge fires later, when the buyer
// reads responses in-app and taps "Chat on WhatsApp" on this vendor's
// response — that hits the existing, unchanged POST /api/search/lead
// (chargeLead), just tagged source: "buyer_request" + requestId. Responding
// here costs the vendor nothing but their own time.
export async function respondToRequest(req, res, next) {
  try {
    const { vendorResponse } = req.body ?? {};
    if (typeof vendorResponse !== "string" || !vendorResponse.trim()) {
      return next(new AppError("A response message is required.", 400));
    }

    const request = await loadMatchedRequestOr404(req, next);
    if (!request) return;

    if (request.status !== "active") {
      return next(new AppError(`This request is no longer active.`, 400));
    }

    let response;
    try {
      response = await BuyerRequestResponse.create({
        requestId: request._id,
        buyerId: request.buyerId,
        vendorId: req.user.userId,
        vendorResponse: vendorResponse.trim(),
      });
    } catch (err) {
      if (err.code === 11000) {
        // Friendlier than the generic errorHandler duplicate-key message —
        // spec §20's exact copy.
        return next(new AppError("You've already responded to this request.", 409));
      }
      throw err;
    }

    // Atomic increment — spec §54 (concurrent responses must not lose
    // updates via an unsafe read-modify-write). The response document
    // itself remains the source of truth; this counter is a denormalized
    // convenience for the buyer-facing status label, never re-derived FROM
    // it in a way that could drift.
    await BuyerRequest.updateOne(
      { _id: request._id },
      { $inc: { responseCount: 1 }, $set: { lastResponseAt: new Date() } },
    );

    // In-app only — the old batched-SMS path (jobs/buyerRequestNotifications.job.js)
    // is retired per explicit product direction; this fires immediately,
    // per response, same as every other buyer/vendor notification trigger
    // in this codebase (not batched — batching existed there purely to cap
    // SMS cost/spam, which doesn't apply to a free in-app row). Best-effort:
    // a failed notify must never fail the response itself.
    try {
      const store = await Store.findOne({ vendorId: req.user.userId })
        .select("name")
        .lean();
      await notifyBuyer(request.buyerId, {
        type: "request-response",
        title: "New response to your request",
        body: store?.name
          ? `${store.name} responded to your request.`
          : "A vendor responded to your request.",
        url: `/buyer/requests/${request._id}`,
      });
    } catch (err) {
      console.error(
        `[vendorBuyerRequests] buyer notify failed for request ${request._id}:`,
        err.message,
      );
    }

    res.status(201).json({ success: true, data: { response } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
