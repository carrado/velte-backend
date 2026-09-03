import BuyerRequest from "../../models/BuyerRequest.model.js";
import BuyerRequestResponse from "../../models/BuyerRequestResponse.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { canAffordLead } from "../wallet/wallet.controller.js";

// Strips the buyer's WhatsApp number off a lean/plain BuyerRequest object.
// ALWAYS, for every vendor, accepted or not (2026-09-03).
//
// It used to be released on Accept, because the number WAS what accepting
// bought: the vendor got it and opened the conversation. That direction is
// gone — the buyer now chooses who to message, from their own requests page,
// and the lead is charged at that click rather than at Accept.
//
// So the buyer's phone is no longer a thing a vendor can earn. It stays on
// the request because the backend still needs it to TEXT the buyer when
// vendors answer (see the notification sweep), which makes it an outbound
// channel and nothing else.
function withoutBuyerPhone(requestObj) {
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
        ...withoutBuyerPhone(r),
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
  if (
    !request ||
    !request.matchedVendorIds.some(
      (id) => String(id) === String(req.user.userId),
    )
  ) {
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

    // myDecision lives ON the request object, same shape as
    // listMatchedRequests below — one consistent BuyerRequest shape for the
    // frontend to type against, not two different ones per endpoint.
    const requestObj = withoutBuyerPhone({
      ...request.toObject(),
      id: String(request._id),
      myDecision: myResponse?.decision ?? null,
    });

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
//   - "declined" costs the vendor nothing and records that they passed.
// NEITHER reveals contact info — the buyer's number is never released to a
// vendor at all (see withoutBuyerPhone). The buyer opens the conversation.
//   - "accepted" costs NOTHING (2026-09-03). It records the vendor's price
//     and puts it in front of the buyer; the lead is charged only if the
//     buyer actually messages them, from the requests page. See
//     search.controller.js's chargeLead, which is now the only place a
//     buyer-request lead is billed.
//
// Accepting is still gated on being able to AFFORD a lead, which is a
// different thing from paying for one. The charge now fires on the buyer's
// click, and the vendor is not there to be told their wallet is empty — so
// the wallet is checked at the last moment the vendor is present, and the
// charge is allowed through later even if the balance moved since. Gate at
// accept, forgive at contact.
//
// The response doc still wins the model's unique (requestId, vendorId) index,
// which is what makes a concurrent double-Accept safe. There is no longer a
// debit to compensate for if it loses.
/** Reads the optional quote off an Accept (2026-09-03).
 *
 *  Every field is optional and an ABSENT field is not an error — see the
 *  model on why requiring a price would be worse than allowing none. What is
 *  an error is a field that is PRESENT and nonsense, because that becomes a
 *  number on a comparison the buyer acts on.
 *
 *  The price ceiling is the one guard worth spelling out: a vendor typing
 *  450000 meaning naira, into a field documented as kobo, is the single most
 *  likely mistake here and would show as ₦4,500. It cannot be detected — both
 *  are plausible prices — so the ceiling only catches the other direction, an
 *  absurd figure that is certainly a slip. The client is what sends kobo, and
 *  the vendor UI takes naira and multiplies.
 */
function readQuote(body, next) {
  const out = { priceKobo: null, leadTimeDays: null, note: null };
  const raw = body?.quote;
  if (raw == null) return out;
  if (typeof raw !== "object") {
    next(new AppError("quote must be an object.", 400));
    return null;
  }

  if (raw.priceKobo != null) {
    const price = Number(raw.priceKobo);
    // ₦1bn. Nothing a vendor on Velte supplies costs this, so anything above
    // it is a typo or a unit mix-up, not a quote.
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000_000 * 100) {
      next(new AppError("quote.priceKobo must be a realistic amount.", 400));
      return null;
    }
    out.priceKobo = Math.round(price);
  }

  if (raw.leadTimeDays != null) {
    const days = Number(raw.leadTimeDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      next(new AppError("quote.leadTimeDays must be 0-365.", 400));
      return null;
    }
    out.leadTimeDays = days;
  }

  if (raw.note != null) {
    if (typeof raw.note !== "string") {
      next(new AppError("quote.note must be text.", 400));
      return null;
    }
    const note = raw.note.trim().slice(0, 200);
    out.note = note || null;
  }

  return out;
}

export async function decideOnRequest(req, res, next) {
  try {
    const { decision } = req.body ?? {};
    if (decision !== "accepted" && decision !== "declined") {
      return next(
        new AppError('decision must be "accepted" or "declined".', 400),
      );
    }

    // Parsed before anything is written, so a malformed quote costs nothing:
    // no response row, no wallet debit, and the vendor can fix it and retry
    // without hitting the unique-index 409 on a decision that never landed.
    const quote = readQuote(req.body, next);
    if (!quote) return;

    const request = await loadMatchedRequestOr404(req, next);
    if (!request) return;

    if (request.status !== "active") {
      return next(new AppError("This request is no longer active.", 400));
    }

    // Checked BEFORE the response row exists, unlike the old charge, which ran
    // after and had to delete the row it had just written when the wallet came
    // up short. Nothing to undo when nothing has been written yet.
    if (decision === "accepted" && !(await canAffordLead(req.user.userId))) {
      return next(
        new AppError(
          "Insufficient wallet balance. Top up to accept this request.",
          402,
        ),
      );
    }

    try {
      await BuyerRequestResponse.create({
        requestId: request._id,
        buyerId: request.buyerId,
        vendorId: req.user.userId,
        decision,
        // Only ever carried by an Accept. A decline releases nothing and is
        // never shown to the buyer, so a price on one would be a number
        // nobody can act on.
        ...(decision === "accepted" ? quote : {}),
      });
    } catch (err) {
      if (err.code === 11000) {
        return next(
          new AppError("You've already responded to this request.", 409),
        );
      }
      throw err;
    }

    // Atomic increment — a denormalized convenience, never re-derived FROM
    // in a way that could drift.
    await BuyerRequest.updateOne(
      { _id: request._id },
      {
        $inc: {
          responseCount: 1,
          // Only accepts move this, and it is what the buyer notification
          // sweep watches — see the model's note on why watching
          // responseCount would announce declines as news.
          ...(decision === "accepted" ? { acceptedCount: 1 } : {}),
        },
        $set: { lastResponseAt: new Date() },
      },
    );

    res.status(201).json({
      success: true,
      data: {
        // No whatsappNumber any more: accepting does not buy a way to reach
        // the buyer, it buys a place in front of them. They message first.
        decision,
        quote: decision === "accepted" ? quote : null,
      },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
