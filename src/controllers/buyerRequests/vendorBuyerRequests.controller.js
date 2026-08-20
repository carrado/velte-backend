import BuyerRequest from "../../models/BuyerRequest.model.js";
import BuyerRequestResponse from "../../models/BuyerRequestResponse.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { debitWalletForLead } from "../wallet/wallet.controller.js";

// Strips the buyer's WhatsApp number off a lean/plain BuyerRequest object
// unless this vendor has actually accepted it — the number is the entire
// value of accepting (see decideOnRequest), so it must never reach the
// client before that, regardless of what the frontend does with it.
function withGatedPhone(requestObj, accepted) {
  if (accepted) return requestObj;
  const { buyerPhone: _omit, ...rest } = requestObj;
  return rest;
}

// ── GET /api/vendor/buyer-requests ──────────────────────────────────────────
// Only requests this vendor was actually matched to — matching itself
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
      .select("requestId decision")
      .lean();
    const decisionByRequestId = new Map(
      ownResponses.map((r) => [String(r.requestId), r.decision]),
    );

    const withFlag = requests.map((r) => {
      const decision = decisionByRequestId.get(String(r._id)) ?? null;
      return {
        ...withGatedPhone(r, decision === "accepted"),
        id: String(r._id), // .lean() drops the `id` virtual — without this
        // every card link (`/${vendorId}/buyer-requests/${request.id}`) is
        // .../undefined.
        myDecision: decision,
      };
    });

    res.status(200).json({ success: true, data: { requests: withFlag } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

async function loadMatchedRequestOr404(req, next) {
  const request = await BuyerRequest.findById(req.params.id);
  if (!request || !request.matchedVendorIds.some((id) => String(id) === String(req.user.userId))) {
    // 404, not 403 — don't confirm a request exists to a vendor it was
    // never matched to.
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

    const myResponse = await BuyerRequestResponse.findOne({
      requestId: request._id,
      vendorId: req.user.userId,
    }).lean();
    const accepted = myResponse?.decision === "accepted";

    // myDecision lives ON the request object, same shape as
    // listMatchedRequests below — one consistent BuyerRequest shape for the
    // frontend to type against, not two different ones per endpoint.
    const requestObj = withGatedPhone(
      {
        ...request.toObject(),
        id: String(request._id),
        myDecision: myResponse?.decision ?? null,
      },
      accepted,
    );

    res.status(200).json({
      success: true,
      data: { request: requestObj },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── POST /api/vendor/buyer-requests/:id/decision — { decision } ────────────
// Replaces the old free-text respondToRequest (2026-08-18) — there's no
// buyer inbox left to read a typed reply in, so the whole interaction is now
// a binary Accept/Decline:
//   - "declined" costs the vendor nothing, records that they passed, and
//     reveals no contact info.
//   - "accepted" charges the vendor's own current tiered lead rate
//     immediately (see leadCostForBalance/LEAD_TIERS in
//     utils/leadPricing.js — the same rate every lead type charges) and
//     hands back the buyer's WhatsApp number right there — the vendor
//     messages them directly from that point on, outside Velte.
// The response doc is created FIRST and must win the model's unique
// (requestId, vendorId) index before any wallet debit is attempted — that's
// what makes a concurrent double-Accept safe: only one request can ever
// create the row, so only one can ever reach the charge below.
export async function decideOnRequest(req, res, next) {
  try {
    const { decision } = req.body ?? {};
    if (decision !== "accepted" && decision !== "declined") {
      return next(new AppError('decision must be "accepted" or "declined".', 400));
    }

    const request = await loadMatchedRequestOr404(req, next);
    if (!request) return;

    if (request.status !== "active") {
      return next(new AppError("This request is no longer active.", 400));
    }

    let response;
    try {
      response = await BuyerRequestResponse.create({
        requestId: request._id,
        buyerId: request.buyerId,
        vendorId: req.user.userId,
        decision,
      });
    } catch (err) {
      if (err.code === 11000) {
        return next(new AppError("You've already responded to this request.", 409));
      }
      throw err;
    }

    if (decision === "accepted") {
      const preview =
        request.description.length > 80
          ? `${request.description.slice(0, 80)}…`
          : request.description;
      const result = await debitWalletForLead(req.user.userId, {
        leadId: `buyer_request_${request._id}_${req.user.userId}`,
        description: `Buyer request lead — ${preview}`,
        source: "buyer_request",
        requestId: String(request._id),
      });
      if (!result.debited) {
        // Compensating delete — leaves no row behind, so the vendor can
        // simply retry Accept once they've topped up, without hitting the
        // unique-index 409 above for a charge that never actually happened.
        await BuyerRequestResponse.deleteOne({ _id: response._id });
        return next(
          new AppError(
            "Insufficient wallet balance. Top up to accept this request.",
            402,
          ),
        );
      }
    }

    // Atomic increment — a denormalized convenience, never re-derived FROM
    // in a way that could drift.
    await BuyerRequest.updateOne(
      { _id: request._id },
      { $inc: { responseCount: 1 }, $set: { lastResponseAt: new Date() } },
    );

    res.status(201).json({
      success: true,
      data: {
        decision,
        whatsappNumber: decision === "accepted" ? request.buyerPhone : null,
      },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
