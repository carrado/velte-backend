import crypto from "crypto";

import Credits from "../../models/Credits.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { CREDIT_PACKS, packFor } from "../../config/creditPacks.js";
import {
  VENDOR_CATALOG_GRANTS,
  catalogGrantCode,
  catalogGrantFor,
} from "../../config/credits.js";
import Product from "../../models/Product.model.js";
import { initializeTransaction } from "../../services/paystack.service.js";
import {
  debitWalletForCredits,
  refundWalletCreditPurchase,
} from "../wallet/wallet.controller.js";
import Buyer from "../../models/Buyer.model.js";
import Wallet from "../../models/Wallet.model.js";
import User from "../../models/Users.js";
import GuestIpUsage from "../../models/GuestIpUsage.model.js";

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

    // Before the debit, so a vendor whose catalogue already earned them
    // credits is never refused for want of a grant nobody had applied yet.
    // A no-op (one indexed lookup) for every vendor already on the top tier.
    if (ownerType === "vendor") await syncVendorCatalogCredits(ownerId);

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
    // What backfills every vendor who had a catalogue before this existed —
    // the gauge is the first thing that reads a balance, so there is no
    // migration to run and no vendor who has to search before being paid.
    if (ownerType === "vendor") await syncVendorCatalogCredits(ownerId);
    const row = await Credits.findOne({ ownerId, ownerType }).lean();

    // A vendor's LEAD WALLET balance travels with the credit balance, because
    // for them the panel has to offer a choice of funding and an offer to
    // "pay from your wallet" without saying what is in it is not an offer.
    // Never fetched for a buyer: they have no wallet, and a null here is what
    // the panel branches on to show the card-only view.
    let walletBalanceKobo = null;
    if (ownerType === "vendor") {
      const wallet = await Wallet.findOne({ vendorId: ownerId })
        .select("balanceKobo")
        .lean()
        // A wallet read failing must not break the credit gauge -- the two are
        // separate ledgers and only one of them is being asked about.
        .catch(() => null);
      walletBalanceKobo = wallet?.balanceKobo ?? 0;
    }

    return res.json({
      success: true,
      data: {
        balance: row?.balance ?? 0,
        ownerType,
        totalGranted: row?.totalGranted ?? 0,
        totalSpent: row?.totalSpent ?? 0,
        walletBalanceKobo,
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


/**
 * Brings a VENDOR's catalogue grant up to whatever their listings have earned.
 *
 * Vendors are paid in credits for the thing Velte actually needs from them —
 * offerings to match against. See config/credits.js VENDOR_CATALOG_GRANTS for
 * why the numbers dwarf a buyer's signup grant.
 *
 * Called from three places, all of them safe to repeat: product creation (the
 * moment a vendor crosses 10 or 20 is when the reward should land), and the
 * balance read + consume paths (which is what backfills every vendor who
 * already had a catalogue before this existed, with no migration to run).
 *
 * TOPS UP TO THE TIER, never re-pays it. Each tier is granted once ever under
 * its own code, and the amount granted is the tier's target MINUS the highest
 * tier already held — so a vendor who joined with 3 products on 50 credits and
 * grows to 20 receives 50 then 100, landing on exactly the 200 the table
 * promises. A catalogue that shrinks and regrows pays nothing the second time,
 * which is what stops delete-and-repost farming.
 *
 * Best-effort and silent on failure: this is a bonus, and a vendor must never
 * lose a product upload or a search because crediting it went wrong.
 */
export async function syncVendorCatalogCredits(vendorId) {
  try {
    const row = await Credits.findOne({ ownerId: vendorId, ownerType: "vendor" })
      .select("grants")
      .lean();
    const held = row?.grants ?? [];

    // The top tier is terminal — once it is held there is nothing left to
    // earn, so the overwhelmingly common case costs one indexed lookup and
    // never counts products at all.
    const top = VENDOR_CATALOG_GRANTS[0];
    if (held.includes(catalogGrantCode(top))) return;

    const count = await Product.countDocuments({ vendorId });
    const tier = catalogGrantFor(count);
    const code = catalogGrantCode(tier);
    if (held.includes(code)) return;

    // The most they have already been paid for their catalogue. `max`, not a
    // sum: the tiers are cumulative targets, so adding them would credit a
    // vendor at 20 offerings for 50 + 100 + 200.
    const alreadyPaid = VENDOR_CATALOG_GRANTS.filter((t) =>
      held.includes(catalogGrantCode(t)),
    ).reduce((most, t) => Math.max(most, t.credits), 0);

    const difference = tier.credits - alreadyPaid;
    // Zero or negative can only mean a tier table edited downward after a
    // vendor was already paid. Recording the code without moving the balance
    // is the right answer: nothing is clawed back, and the tier stops being
    // re-evaluated on every call.
    if (difference <= 0) {
      await Credits.updateOne(
        { ownerId: vendorId, ownerType: "vendor" },
        { $addToSet: { grants: code } },
      );
      return;
    }

    const { granted, balance } = await grantCredits(
      vendorId,
      "vendor",
      code,
      difference,
    );
    if (granted) {
      console.log(
        `[credits] +${difference} to vendor ${vendorId} for ${count} offerings (${code}), balance ${balance}`,
      );
    }
  } catch (err) {
    console.error(
      "[credits] vendor catalogue grant failed (ignored):",
      err?.message,
    );
  }
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

    // initializeTransaction already returns the UNWRAPPED data object
    // (paystack.service.js's own paystackFetch resolves to `data.data`, not
    // the full Paystack envelope) — wallet.controller.js's own call reads
    // `transaction.authorization_url` directly for the same reason. This
    // used to read `result?.data?.authorization_url`, one `.data` too many,
    // so `authorizationUrl` was undefined on every call — including a
    // genuinely successful one — and every card top-up failed with the
    // generic message below regardless of whether Paystack ever objected.
    const authorizationUrl = result?.authorization_url;
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

// ── POST /api/credits/wallet-topup ───────────────────────────────
//
// Body: { packId: "shopper" }
// 200:  { success, data: { balance, credits, amountKobo, walletBalanceKobo } }
//
// VENDORS ONLY, and the only thing on Velte that spends wallet money on
// anything other than a lead. A vendor already keeps a float with us; making
// them re-enter a card to buy search is the kind of friction that stops a
// vendor using their own product. Buyers have no wallet, so for them this
// simply does not exist.
//
// Same packs, same naira prices as the card route. The funding source is a
// funding source, not a second price list -- a credit costs a vendor exactly
// what it costs a buyer.
//
// UNLIKE the card route this completes IN THE REQUEST. There is no Paystack
// round trip and therefore no webhook to wait for: the money is already ours,
// so the debit and the grant both happen here and the vendor sees the new
// balance immediately.
//
// Buying credits does NOT worsen this vendor's lead rate, and since
// 2026-09-03 nothing has to be done to keep it that way: the lead price is a
// single flat rate, so spending the wallet down cannot move it. This used to
// need a 30-day credit-spend window to stop ₦600 spent here costing ₦200 more
// on every subsequent lead.
export async function initWalletTopUp(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    if (req.actor.type !== "vendor") {
      // A buyer reaching this has no wallet to spend, and saying so plainly
      // is better than a 404 that reads like the feature is broken.
      throw new AppError(
        "Only vendor accounts have a Velte wallet. Top up with a card instead.",
        403,
      );
    }
    const pack = packFor(req.body?.packId);
    if (!pack) throw new AppError("Unknown credit pack.", 400);

    // Ours, random, and carrying nothing about who bought what -- the same
    // discipline as the Paystack reference above. `vcredw` (w for wallet)
    // keeps the two purchase kinds distinguishable in the ledger at a glance.
    const reference = `vcredw_${crypto.randomBytes(12).toString("hex")}`;

    const debit = await debitWalletForCredits(req.actor.id, pack, reference);
    if (!debit.debited) {
      if (debit.reason === "already_paid") {
        throw new AppError("That purchase already went through.", 409);
      }
      // Named amounts, because the vendor's next action depends on the gap.
      throw new AppError(
        `Your Velte wallet doesn't have the ₦${pack.priceNgn.toLocaleString(
          "en-NG",
        )} for this pack. Top the wallet up, or pay with a card.`,
        402,
      );
    }

    let granted;
    try {
      // Idempotent on the reference, like every other grant here -- a retry
      // that got as far as the grant cannot pay twice.
      granted = await grantCredits(
        req.actor.id,
        "vendor",
        `topup:${reference}`,
        pack.credits,
      );
    } catch (err) {
      // The money left the wallet and the credits never arrived. Put it back
      // rather than leaving a vendor short with nothing to show for it.
      await refundWalletCreditPurchase(
        req.actor.id,
        debit.amountKobo,
        reference,
      );
      throw err;
    }

    console.log(
      `[credits] +${pack.credits} to vendor ${req.actor.id} from wallet (${reference}), balance ${granted.balance}`,
    );

    return res.json({
      success: true,
      data: {
        balance: granted.balance,
        credits: pack.credits,
        amountKobo: debit.amountKobo,
        // So the panel can redraw the wallet figure it just spent from
        // without a second request.
        walletBalanceKobo: debit.wallet.balanceKobo,
        reference,
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

// How many guest TURNS one address may generate before the network-level
// backstop engages (2026-09-05). Counted in turns, not credits — simpler to
// reason about, and each turn's actual price is already the browser-side
// GUEST_CREDITS allowance's job (lib/credits.ts on the frontend), not this
// backstop's.
//
// Sized as roughly 40 "fresh guest browsers" worth of activity (5 turns
// apiece, GUEST_CREDITS' own ceiling) from ONE address in a day. Deliberately
// generous: this exists to catch someone repeatedly resetting their OWN
// browser to keep re-claiming a free allowance, not to measure anything
// precisely — carrier-grade mobile NAT means dozens of genuine strangers can
// legitimately share one address in a day. An ESTIMATE, the same honest
// caveat lib/credits.ts's own cost ratios carry: the number to revisit once
// there is real guest traffic to look at, not a value settled by reasoning
// alone.
const GUEST_IP_DAILY_LIMIT = 200;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// ── POST /api/credits/guest-usage ────────────────────────────────────────
//
// The network-level backstop behind a guest's own browser-side allowance
// (2026-09-05, see GuestIpUsage.model.js for the full reasoning). Called by
// the frontend's /api/search route once per GUEST turn, before any model or
// retrieval call runs — same placement rule every other credit gate in this
// system follows.
//
// Public and unauthenticated on purpose, the same trust level as GET
// /packs: nothing sensitive is read or written here, and the worst a
// stranger calling this directly could do is inflate a COUNTER — never
// spend real money, never touch a real account's balance. `ip` is trusted
// as given by the caller (the frontend's own BFF route, which reads it off
// the actual incoming request's forwarded-for header) rather than
// re-derived from the socket here — that socket only ever sees the BFF's
// own address, never the guest's.
export async function checkGuestIpUsage(req, res, next) {
  try {
    const ip = typeof req.body?.ip === "string" ? req.body.ip.trim() : "";
    if (!ip) {
      // No usable address to bucket by — fail OPEN, the same direction
      // every other gate in this system fails. Refusing a guest because we
      // could not tell where they came from would be a worse outcome than
      // letting one more turn through unmetered by this one check.
      return res.json({ success: true, data: { allowed: true } });
    }

    const day = todayUtc();
    const row = await GuestIpUsage.findOneAndUpdate(
      { ip, day },
      { $inc: { count: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return res.json({
      success: true,
      data: { allowed: row.count <= GUEST_IP_DAILY_LIMIT, count: row.count },
    });
  } catch (err) {
    next(err);
  }
}
