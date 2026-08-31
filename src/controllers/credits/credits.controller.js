import crypto from "crypto";

import Credits from "../../models/Credits.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { CREDIT_PACKS, packFor } from "../../config/creditPacks.js";
import { initializeTransaction } from "../../services/paystack.service.js";
import Buyer from "../../models/Buyer.model.js";
import User from "../../models/Users.js";

// Credit spending for any signed-in account (2026-08-31).
//
// THE COSTS ARE PASSED IN, the balance is owned here — the same division the
// old usage controller used, and for the same reason: the price table lives in
// the frontend (src/lib/server/ai/credits.ts) because that is where the gate,
// the refusal copy and the credit gauge all read from, and one table that
// cannot disagree with itself beats two that drift. This file never decides
// what anything costs; it decides whether the balance covers it, atomically.
//
// GRANTING IS NOT AN ENDPOINT. There is deliberately no route that hands out
// credits: a client that could call one could mint its own. Grants happen
// server-side inside the flows that earn them — account creation, a completed
// referral, a verified Paystack top-up — via `grantCredits` below.

/** Nothing may cost more than this in one action. A guard against a caller
 *  (or a bug) draining a balance in a single request — the most expensive
 *  real action today is 5. */
const MAX_ACTION_COST = 100;

function validCost(value) {
  return (
    Number.isInteger(value) && value > 0 && value <= MAX_ACTION_COST
  );
}

async function rowFor(ownerId, ownerType) {
  // Filtered on the owner alone so an existing row simply matches and
  // `$setOnInsert` does nothing. A duplicate-key from two concurrent
  // first-requests is the outcome we wanted anyway — the row exists.
  await Credits.updateOne(
    { ownerId, ownerType },
    { $setOnInsert: { balance: 0, grants: [], totalGranted: 0, totalSpent: 0 } },
    { upsert: true },
  ).catch((err) => {
    if (err?.code !== 11000) throw err;
  });
  return Credits.findOne({ ownerId, ownerType }).lean();
}

// ── POST /api/credits/consume ────────────────────────────────────────────
//
// Body: { cost: 5, action: "photo" }
// 200:  { success, data: { allowed, balance, cost } }
//
// `allowed: false` is a normal outcome — an empty balance, not an error — so
// it returns 200 with the balance. The caller needs it either way to tell the
// buyer how far they are from affording what they asked for.
export async function consumeCredits(req, res, next) {
  try {
    const { cost, action } = req.body ?? {};
    if (!validCost(cost)) {
      throw new AppError(
        `cost must be a positive integer no greater than ${MAX_ACTION_COST}.`,
        400,
      );
    }
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const { id: ownerId, type: ownerType } = req.actor;

    await rowFor(ownerId, ownerType);

    // The `$gte` sits in the FILTER, so the affordability check and the debit
    // are one document-level operation. Two searches landing together cannot
    // both spend the last credit, and the balance can never go negative.
    const updated = await Credits.findOneAndUpdate(
      { ownerId, ownerType, balance: { $gte: cost } },
      { $inc: { balance: -cost, totalSpent: cost } },
      { new: true },
    ).lean();

    if (updated) {
      return res.json({
        success: true,
        data: { allowed: true, balance: updated.balance, cost },
      });
    }

    const current = await Credits.findOne({ ownerId, ownerType })
      .lean()
      .catch(() => null);
    return res.json({
      success: true,
      data: {
        allowed: false,
        balance: current?.balance ?? 0,
        cost,
        action: typeof action === "string" ? action : undefined,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/credits/refund ─────────────────────────────────────────────
//
// Gives a charge back. Exists for one case and should stay that narrow: a
// search turn is charged BEFORE it runs (so an empty balance is refused
// before we spend money on it), but a turn that resolves through the nearby-
// business / Google Places fallback is not billable — it never reached
// Serper. Charging up front and refunding is how a turn can be both "refused
// early" and "free when it turns out not to have cost anything".
export async function refundCredits(req, res, next) {
  try {
    const { cost } = req.body ?? {};
    if (!validCost(cost)) {
      throw new AppError("cost must be a positive integer.", 400);
    }
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const { id: ownerId, type: ownerType } = req.actor;

    // Never below zero on totalSpent either — a refund of a charge that was
    // never applied (a retry, a race) must not manufacture credits, so this is
    // filtered on there being something to give back.
    const updated = await Credits.findOneAndUpdate(
      { ownerId, ownerType, totalSpent: { $gte: cost } },
      { $inc: { balance: cost, totalSpent: -cost } },
      { new: true },
    ).lean();

    return res.json({
      success: true,
      data: { balance: updated?.balance ?? 0, refunded: Boolean(updated) },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/credits ─────────────────────────────────────────────────────
//
// Read-only, never mutates, safe to call on render — this is what the credit
// gauge reads.
export async function getCredits(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const { id: ownerId, type: ownerType } = req.actor;
    const row = await Credits.findOne({ ownerId, ownerType }).lean();
    return res.json({
      success: true,
      data: {
        balance: row?.balance ?? 0,
        ownerType,
        totalGranted: row?.totalGranted ?? 0,
        totalSpent: row?.totalSpent ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Adds credits to an account, once per `code`.
 *
 * NOT A ROUTE, and must never become one — see this file's header. Call it
 * from the server-side flow that earns the grant:
 *
 *   grantCredits(buyerId, "buyer", "signup", 15)
 *   grantCredits(referrerId, "buyer", `referral:${referralId}`, 5)
 *   grantCredits(buyerId, "buyer", `topup:${paystackRef}`, 350)
 *
 * IDEMPOTENT BY CODE, which is the entire point. Paystack retries webhooks, a
 * referral can fire twice under a race, and a signup handler can be re-entered
 * — the code identifies the EVENT, so a repeat finds it already recorded and
 * changes nothing. `$ne` in the filter is what makes that atomic rather than a
 * read-then-write anyone could interleave with.
 *
 * Returns whether this call was the one that applied it.
 */
export async function grantCredits(ownerId, ownerType, code, amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError("grant amount must be a positive integer.", 400);
  }
  if (typeof code !== "string" || !code.trim()) {
    throw new AppError("a grant needs a code to be idempotent on.", 400);
  }

  await Credits.updateOne(
    { ownerId, ownerType },
    { $setOnInsert: { balance: 0, grants: [], totalGranted: 0, totalSpent: 0 } },
    { upsert: true },
  ).catch((err) => {
    if (err?.code !== 11000) throw err;
  });

  const updated = await Credits.findOneAndUpdate(
    { ownerId, ownerType, grants: { $ne: code } },
    {
      $inc: { balance: amount, totalGranted: amount },
      $push: { grants: code },
    },
    { new: true },
  ).lean();

  // null means the code was already there — an honest no-op, not a failure.
  return { granted: Boolean(updated), balance: updated?.balance ?? null };
}


// ── GET /api/credits/packs ───────────────────────────────────────────────
//
// The price list, from the table that actually charges. Public on purpose —
// the credits panel needs it before anyone signs in — and it exposes nothing
// but prices meant to be published.
export async function listPacks(_req, res, next) {
  try {
    return res.json({ success: true, data: { packs: CREDIT_PACKS } });
  } catch (err) {
    next(err);
  }
}

function modelForActorType(type) {
  return type === "vendor" ? User : Buyer;
}

/** Where Paystack sends the buyer back. `/chat` rather than a receipts page:
 *  somebody who just topped up wants to be back where they were, mid-search. */
const CALLBACK_PATH = "/chat?topup=done";

function callbackUrl() {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return base ? `${base}${CALLBACK_PATH}` : undefined;
}

// ── POST /api/credits/checkout ───────────────────────────────────────────
//
// Body: { packId: "shopper" }
// 200:  { success, data: { authorizationUrl, reference, amountKobo } }
//
// The caller names the PACK. The price and the credit count come from this
// repo's own table — never from the request — for the same reason plan prices
// never travelled from the client: a caller that could name the amount could
// name a smaller one.
export async function initTopUp(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const pack = packFor(req.body?.packId);
    if (!pack) throw new AppError("Unknown credit pack.", 400);

    const account = await modelForActorType(req.actor.type)
      .findById(req.actor.id)
      .select("email")
      .lean();
    if (!account) throw new AppError("Account not found.", 404);

    // Paystack requires an email to open a transaction. Every Google buyer
    // and every vendor has one; the honest answer for anyone who doesn't is
    // to say so rather than invent a placeholder that then receives their
    // receipt.
    if (!account.email) {
      throw new AppError(
        "Add an email to your account before topping up — Paystack needs one to send your receipt.",
        400,
      );
    }

    // Carries no secrets, and random rather than derived from the account id
    // so a reference in a URL or a support screenshot reveals nothing about
    // who bought what.
    const reference = `vcred_${crypto.randomBytes(12).toString("hex")}`;

    const result = await initializeTransaction({
      email: account.email,
      // initializeTransaction takes NAIRA and converts — see its own comment.
      amount: pack.priceNgn,
      reference,
      callbackUrl: callbackUrl(),
      metadata: {
        // The discriminator the webhook branches on. Must stay distinct from
        // "wallet_topup" (the vendor lead wallet) and "buyer_plan" (the
        // retired subscription), both of which land on the same handler.
        type: "credit_topup",
        ownerId: String(req.actor.id),
        ownerType: req.actor.type,
        packId: pack.id,
        // Recorded so a mismatch between what we meant to charge and what
        // Paystack reports is visible in the webhook rather than silent.
        amountKobo: pack.priceNgn * 100,
      },
      // No subaccount: credits are Velte's own revenue, not a marketplace
      // payment being split to a vendor.
    });

    const authorizationUrl = result?.data?.authorization_url;
    if (!authorizationUrl) {
      throw new AppError("Couldn't start the payment. Please try again.", 502);
    }

    return res.json({
      success: true,
      data: {
        authorizationUrl,
        reference,
        amountKobo: pack.priceNgn * 100,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Credits an account from a verified `charge.success` webhook. Called by the
 * webhook handler, never by a route.
 *
 * Idempotent because `grantCredits` is: the grant code carries the Paystack
 * reference, so Paystack's retries — which are routine, not exceptional —
 * find the code already recorded and change nothing. A buyer must never get
 * two top-ups for one payment.
 */
export async function creditFromCharge(meta) {
  const { ownerId, ownerType, packId, reference } = meta ?? {};
  const pack = packFor(packId);
  if (!ownerId || !pack || !reference) {
    console.error(
      "[credits] charge.success with unusable metadata — ignored:",
      JSON.stringify(meta),
    );
    return;
  }
  const { granted, balance } = await grantCredits(
    ownerId,
    ownerType === "vendor" ? "vendor" : "buyer",
    `topup:${reference}`,
    pack.credits,
  );
  if (granted) {
    console.log(
      `[credits] +${pack.credits} to ${ownerType} ${ownerId} (${reference}), balance ${balance}`,
    );
  }
}
