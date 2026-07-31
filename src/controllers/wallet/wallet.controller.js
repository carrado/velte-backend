import crypto from "crypto";
import Wallet from "../../models/Wallet.model.js";
import WalletTransaction from "../../models/WalletTransaction.model.js";
import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  initializeTransaction,
  verifyTransaction,
  createCustomer,
  createDedicatedVirtualAccount,
  chargeAuthorization,
} from "../../services/paystack.service.js";
import { LOW_BALANCE_KOBO } from "../../jobs/walletLowBalance.job.js";
import { notifyUser } from "../../services/pushNotification.service.js";

// Every direct balance credit must clear this immediately, not wait for the
// cron's point-in-time sample — a wallet that dips below the threshold,
// gets topped up back above it, then dips low again inside one poll window
// never gets observed above the threshold by the cron, so its
// `lowBalanceLastNotifiedAt` would otherwise stay stuck set forever and
// silently suppress every future low-balance alert (both the initial one
// for a new episode AND the 24h reminder) for that wallet.
function clearLowBalanceFlagIfRecovered(wallet) {
  if (wallet.lowBalanceLastNotifiedAt && wallet.balanceKobo >= LOW_BALANCE_KOBO) {
    wallet.lowBalanceLastNotifiedAt = null;
  }
}

// Same idea as clearLowBalanceFlagIfRecovered, but against the vendor's own
// auto-recharge threshold rather than the fixed global LOW_BALANCE_KOBO —
// ends a failure episode (see maybeAutoRecharge) the moment the balance
// recovers via ANY credit, not just a successful auto-recharge charge
// itself (a manual top-up or DVA transfer should stop the retry/notify
// cycle just as well). Called from every place a wallet gets credited.
function clearAutoRechargeFailureIfRecovered(wallet) {
  if (
    wallet.autoRecharge.failureFirstAt &&
    wallet.balanceKobo >= wallet.autoRecharge.thresholdKobo
  ) {
    wallet.autoRecharge.failureFirstAt = null;
    wallet.autoRecharge.failureLastAttemptAt = null;
    wallet.autoRecharge.failureNotifyCount = 0;
    wallet.autoRecharge.lastFailureNotifiedAt = null;
  }
}

// New vendors get a one-time, non-refundable starter credit so they can see
// real leads land before ever having to trust the AI matching enough to pay
// for one — removes the cold-start "prepay with zero track record" barrier.
const STARTER_CREDIT_KOBO = 200_000; // ₦2,000

// ₦400 per WhatsApp click-through. This is the source of truth — this
// endpoint (chargeLead) charges exactly this amount when a lead actually
// lands. The standalone staffly-ai-backend service's search-time wallet-
// eligibility filter reads the SAME value from its own LEAD_COST_KOBO env
// var (see its README) since it can't import this constant across repos —
// keep both equal by hand.
export const LEAD_COST_KOBO = 40_000;

// Floor for top-ups and auto-recharge amounts — keeps card fees proportionate
// and matches the frontend's client-side minimum.
const MIN_AMOUNT_NAIRA = 1000;
const MIN_AMOUNT_KOBO = MIN_AMOUNT_NAIRA * 100;

// Wallet creation (incl. the starter-credit grant) is sole-owned here — the
// standalone staffly-ai-backend search service only ever READS a wallet, it
// never creates one (see its README). So this must run proactively before a
// vendor's listings could appear in search, not lazily on first search:
// store.controller.js's getOrCreateStore calls this right after a store is
// first created.
export async function getOrCreateWallet(vendorId) {
  // Atomic get-or-create: concurrent callers all converge on the same document
  // via the unique index on vendorId — upsert can't create duplicates.
  let wallet = await Wallet.findOneAndUpdate(
    { vendorId },
    { $setOnInsert: { vendorId } },
    { upsert: true, new: true },
  );

  // Atomic claim on the starter credit. findOneAndUpdate is a single-document
  // operation in MongoDB, so of any number of requests racing here (e.g.
  // getWallet + getTransactions firing together on first page load), only one
  // can match `starterCreditGranted: false` and flip it — no dependency on the
  // WalletTransaction unique index (which builds asynchronously in the
  // background and isn't guaranteed to be active yet on a freshly-started
  // server, which is exactly how the double-credit bug happened).
  const claimed = await Wallet.findOneAndUpdate(
    { vendorId, starterCreditGranted: false },
    { $set: { starterCreditGranted: true }, $inc: { balanceKobo: STARTER_CREDIT_KOBO } },
    { new: true },
  );

  if (claimed) {
    wallet = claimed;
    try {
      await WalletTransaction.create({
        walletId: wallet._id,
        vendorId,
        type: "topup",
        amountKobo: STARTER_CREDIT_KOBO,
        balanceAfterKobo: wallet.balanceKobo,
        reference: `starter_credit_${vendorId}`,
        status: "success",
        channel: "starter_credit",
        description: "Welcome credit",
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }

  return wallet;
}

function serializeWallet(wallet) {
  return {
    balanceKobo: wallet.balanceKobo,
    currency: wallet.currency,
    autoRecharge: {
      enabled: wallet.autoRecharge.enabled,
      pendingEnable: wallet.autoRecharge.pendingEnable,
      thresholdKobo: wallet.autoRecharge.thresholdKobo,
      topupKobo: wallet.autoRecharge.topupKobo,
      hasCardOnFile: !!wallet.autoRecharge.authorizationCode,
      last4: wallet.autoRecharge.last4,
      cardType: wallet.autoRecharge.cardType,
    },
    dva: wallet.dva.accountNumber
      ? {
          accountNumber: wallet.dva.accountNumber,
          bankName: wallet.dva.bankName,
          accountName: wallet.dva.accountName,
        }
      : null,
    status: wallet.status,
  };
}

// ── GET /api/wallet ──────────────────────────────────────────────────────────

export async function getWallet(req, res, next) {
  try {
    const wallet = await getOrCreateWallet(req.user.userId);
    res.json({ success: true, data: serializeWallet(wallet) });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/wallet/topup/initialize ───────────────────────────────────────
// Hosted Paystack checkout (authorization_url) rather than the Inline JS SDK —
// no public key wiring needed client-side, and it's the pattern already proven
// elsewhere in this app for redirect-based checkout.

export async function initializeTopup(req, res, next) {
  try {
    const amountNaira = Number(req.body?.amountNaira);
    if (!Number.isFinite(amountNaira) || amountNaira < MIN_AMOUNT_NAIRA) {
      throw new AppError(`Minimum top-up is ₦${MIN_AMOUNT_NAIRA.toLocaleString("en-NG")}.`, 400);
    }

    // First-time auto-recharge setup: preferences ride along in the Paystack
    // metadata and are only written to the wallet once the payment succeeds
    // and a reusable card authorization is captured (see
    // creditWalletFromReference) — nothing is stored if checkout is abandoned.
    let autoRecharge = null;
    if (req.body?.autoRecharge) {
      const thresholdKobo = Number(req.body.autoRecharge.thresholdKobo);
      const topupKobo = Number(req.body.autoRecharge.topupKobo);
      if (
        !Number.isFinite(thresholdKobo) ||
        thresholdKobo < MIN_AMOUNT_KOBO ||
        !Number.isFinite(topupKobo) ||
        topupKobo < MIN_AMOUNT_KOBO
      ) {
        throw new AppError(
          `Auto-recharge amounts must be at least ₦${MIN_AMOUNT_NAIRA.toLocaleString("en-NG")}.`,
          400,
        );
      }
      autoRecharge = { thresholdKobo, topupKobo };
    }

    const user = await User.findById(req.user.userId).select("email");
    if (!user) throw new AppError("User not found.", 404);

    const wallet = await getOrCreateWallet(req.user.userId);

    const reference = `wallet_${req.user.userId}_${Date.now()}_${crypto
      .randomBytes(4)
      .toString("hex")}`;

    const transaction = await initializeTransaction({
      email: user.email,
      amount: amountNaira,
      reference,
      callbackUrl: `${process.env.FRONTEND_URL}/payment/callback?reference=${reference}`,
      metadata: {
        type: "wallet_topup",
        vendorId: req.user.userId.toString(),
        walletId: wallet._id.toString(),
        ...(autoRecharge ? { autoRecharge } : {}),
      },
      // Auto-recharge setup must be paid by card — capturing the reusable
      // authorization is the whole point, and a transfer would credit the
      // wallet without ever activating auto-recharge. Plain top-ups accept
      // bank transfer too.
      channels: autoRecharge ? ["card"] : ["card", "bank_transfer"],
    });

    res.json({
      success: true,
      data: {
        authorizationUrl: transaction.authorization_url,
        reference: transaction.reference,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/wallet/topup/verify ───────────────────────────────────────────
// Called by the /payment/callback page after the vendor returns from Paystack.
// Idempotent — safe to call even if the webhook already credited the wallet.

export async function verifyTopup(req, res, next) {
  try {
    const { reference } = req.body ?? {};
    if (!reference) throw new AppError("reference is required.", 400);

    const wallet = await creditWalletFromReference(reference, req.user.userId);
    res.json({ success: true, data: serializeWallet(wallet) });
  } catch (err) {
    next(err);
  }
}

// Shared credit path — called from verifyTopup (buyer-initiated poll), from
// the Paystack webhook (server-to-server, authoritative), AND from
// maybeAutoRecharge right after a successful charge_authorization call — a
// charge made via charge_authorization ALSO fires Paystack's own
// charge.success webhook for that same underlying transaction, so the direct
// post-charge call and the webhook race for the SAME reference exactly like
// verify + webhook already did for a hosted-checkout top-up. Whichever gets
// there first wins; the unique index on WalletTransaction.reference makes
// the other a no-op instead of a double-credit — found live (2026-07-23):
// that index existed in the DB WITHOUT the unique constraint actually
// applied (a pre-existing plain index from before `unique: true` was added
// to the schema — Mongoose's autoIndex never retroactively upgrades an
// existing index's options), so it silently let both racing calls insert a
// ledger row for the identical reference, double-crediting an auto-recharge
// by ₦2,000. Fixed the index itself in a one-off migration (see
// scripts/fix-wallet-transaction-index.js), but this function no longer
// trusts the index alone: the credit itself is now applied via atomic $inc
// (never a stale-snapshot `.save()`), and reverted via the same atomic $inc
// if the ledger insert turns out to be the loser of the race — correct
// regardless of whether any index is present at all.
async function creditWalletFromReference(reference, expectedVendorId = null) {
  const existing = await WalletTransaction.findOne({ reference });
  if (existing) {
    return Wallet.findById(existing.walletId);
  }

  const transaction = await verifyTransaction(reference);
  if (transaction.status !== "success") {
    throw new AppError(`Payment ${transaction.status}.`, 402);
  }

  const meta = transaction.metadata || {};
  if (meta.type !== "wallet_topup") {
    throw new AppError("Reference does not belong to a wallet top-up.", 400);
  }
  if (expectedVendorId && meta.vendorId !== expectedVendorId.toString()) {
    throw new AppError("Reference does not belong to this account.", 403);
  }

  const walletBefore = await getOrCreateWallet(meta.vendorId);
  const amountKobo = transaction.amount; // Paystack already reports amount in kobo

  // Atomic credit — never a read-modify-write `.save()`, which two racing
  // callers could otherwise both base on the same stale snapshot and silently
  // lose one of the two increments (a DIFFERENT failure mode than the
  // double-credit this whole function is about, but just as real a risk from
  // the exact same "two callers, one reference" race).
  let wallet = await Wallet.findOneAndUpdate(
    { _id: walletBefore._id },
    { $inc: { balanceKobo: amountKobo } },
    { new: true },
  );

  try {
    await WalletTransaction.create({
      walletId: wallet._id,
      vendorId: wallet.vendorId,
      type: "topup",
      amountKobo,
      balanceAfterKobo: wallet.balanceKobo,
      reference,
      status: "success",
      channel: transaction.channel ?? "card",
      description: "Wallet top-up",
    });
  } catch (err) {
    // Duplicate reference raced us (webhook + verify, or webhook +
    // maybeAutoRecharge's direct call, landed together) — we lost the race:
    // revert this call's own credit atomically (the winner's credit and
    // ledger row already stand) and return the wallet as the winner left it.
    if (err.code === 11000) {
      wallet = await Wallet.findOneAndUpdate(
        { _id: wallet._id },
        { $inc: { balanceKobo: -amountKobo } },
        { new: true },
      );
      return wallet;
    }
    throw err;
  }

  clearLowBalanceFlagIfRecovered(wallet);
  clearAutoRechargeFailureIfRecovered(wallet);

  // First successful card top-up captures a reusable authorization for
  // auto-recharge — never charged per-lead, only for future batched top-ups.
  const auth = transaction.authorization;
  if (auth?.reusable && auth.authorization_code) {
    wallet.autoRecharge.authorizationCode = auth.authorization_code;
    wallet.autoRecharge.last4 = auth.last4 ?? null;
    wallet.autoRecharge.cardType = auth.card_type ?? null;

    // First-time setup rode along in the metadata (see initializeTopup):
    // the payment succeeded and we hold a chargeable card, so persist the
    // preferences and switch auto-recharge on in one go. Plain top-ups carry
    // no autoRecharge metadata and change nothing here.
    const prefs = meta.autoRecharge;
    if (prefs) {
      const thresholdKobo = Number(prefs.thresholdKobo);
      const topupKobo = Number(prefs.topupKobo);
      if (
        Number.isFinite(thresholdKobo) &&
        thresholdKobo >= MIN_AMOUNT_KOBO &&
        Number.isFinite(topupKobo) &&
        topupKobo >= MIN_AMOUNT_KOBO
      ) {
        wallet.autoRecharge.thresholdKobo = thresholdKobo;
        wallet.autoRecharge.topupKobo = topupKobo;
        wallet.autoRecharge.enabled = true;
        wallet.autoRecharge.pendingEnable = false;
      }
    }

    // Honor pre-card intent: the vendor saved funding preferences before any
    // card existed, so the first captured authorization activates
    // auto-recharge without another trip to the funding modal. Vendors who
    // only ever topped up (never saved preferences) are left alone.
    if (
      wallet.autoRecharge.pendingEnable &&
      wallet.autoRecharge.thresholdKobo > 0 &&
      wallet.autoRecharge.topupKobo > 0
    ) {
      wallet.autoRecharge.enabled = true;
      wallet.autoRecharge.pendingEnable = false;
    }
  }

  await wallet.save();

  return wallet;
}

// Called from the Paystack webhook (subscription.controller.js) — never throws,
// a webhook handler must not 500 Paystack into an endless retry loop.
//
// Two charge.success shapes land here:
//  - Card top-up: initiated by us via initializeTopup, so `data.metadata.type
//    === "wallet_topup"` and `data.reference` is one we generated —
//    creditWalletFromReference re-verifies and credits by that path.
//  - DVA bank transfer: the vendor transferred directly into their assigned
//    NUBAN, so there's no metadata we set and no reference we generated —
//    only `data.channel === "dedicated_nuban"` and `data.customer.customer_code`
//    to identify which wallet it belongs to.
export async function creditWalletFromCharge(data) {
  try {
    if (data.metadata?.type === "wallet_topup") {
      await creditWalletFromReference(data.reference);
      return;
    }
    if (data.channel === "dedicated_nuban") {
      await creditWalletFromDvaTransfer(data);
      return;
    }
    console.log(
      `[wallet webhook] charge.success not attributable to a wallet — ignored (reference: ${data.reference})`,
    );
  } catch (err) {
    console.error("[wallet webhook] credit failed:", err.message);
  }
}

async function creditWalletFromDvaTransfer(data) {
  const existing = await WalletTransaction.findOne({ reference: data.reference });
  if (existing) return;

  const customerCode = data.customer?.customer_code;
  if (!customerCode) return;

  const wallet = await Wallet.findOne({ paystackCustomerCode: customerCode });
  if (!wallet) {
    console.log(`[wallet webhook] no wallet for customer ${customerCode}`);
    return;
  }

  const amountKobo = data.amount;
  wallet.balanceKobo += amountKobo;
  clearLowBalanceFlagIfRecovered(wallet);
  clearAutoRechargeFailureIfRecovered(wallet);
  await wallet.save();

  try {
    await WalletTransaction.create({
      walletId: wallet._id,
      vendorId: wallet.vendorId,
      type: "topup",
      amountKobo,
      balanceAfterKobo: wallet.balanceKobo,
      reference: data.reference,
      status: "success",
      channel: "dedicated_nuban",
      description: "Wallet top-up via bank transfer",
    });
  } catch (err) {
    if (err.code === 11000) {
      wallet.balanceKobo -= amountKobo;
      await wallet.save();
      return;
    }
    throw err;
  }
}

// ── PUT /api/wallet/funding-method ──────────────────────────────────────────
// Configure auto-recharge thresholds. Requires a card already on file (from a
// prior top-up) — this never collects card details itself.

export async function setFundingMethod(req, res, next) {
  try {
    const { enabled, thresholdKobo, topupKobo } = req.body ?? {};
    const wallet = await getOrCreateWallet(req.user.userId);
    const hasCard = !!wallet.autoRecharge.authorizationCode;

    if (hasCard) {
      // Card on file: the toggle is authoritative, and an explicit choice
      // supersedes any earlier pre-card intent.
      if (enabled !== undefined) wallet.autoRecharge.enabled = !!enabled;
      wallet.autoRecharge.pendingEnable = false;
    } else {
      // No card yet: `enabled` can't take effect (nothing to charge), so
      // saving preferences records the intent instead — auto-recharge turns
      // on automatically when the first card top-up captures an
      // authorization (see creditWalletFromReference).
      wallet.autoRecharge.enabled = false;
      wallet.autoRecharge.pendingEnable = true;
    }
    // Both amounts share the same ₦1,000 floor as manual top-ups — a lower
    // threshold could still be meaningful, but a "top up by" below the minimum
    // would auto-charge amounts we don't accept anywhere else.
    if (thresholdKobo !== undefined) {
      if (!Number.isFinite(thresholdKobo) || thresholdKobo < MIN_AMOUNT_KOBO) {
        throw new AppError(
          `Recharge threshold must be at least ₦${MIN_AMOUNT_NAIRA.toLocaleString("en-NG")}.`,
          400,
        );
      }
      wallet.autoRecharge.thresholdKobo = thresholdKobo;
    }
    if (topupKobo !== undefined) {
      if (!Number.isFinite(topupKobo) || topupKobo < MIN_AMOUNT_KOBO) {
        throw new AppError(
          `Top-up amount must be at least ₦${MIN_AMOUNT_NAIRA.toLocaleString("en-NG")}.`,
          400,
        );
      }
      wallet.autoRecharge.topupKobo = topupKobo;
    }

    await wallet.save();
    res.json({ success: true, data: serializeWallet(wallet) });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/wallet/dva ─────────────────────────────────────────────────────
// Issues a Dedicated Virtual Account for bank-transfer top-ups.

export async function requestDva(req, res, next) {
  try {
    const wallet = await getOrCreateWallet(req.user.userId);
    if (wallet.dva.accountNumber) {
      return res.json({ success: true, data: serializeWallet(wallet) });
    }

    const user = await User.findById(req.user.userId).select("email name");
    if (!user) throw new AppError("User not found.", 404);

    let customerCode = wallet.paystackCustomerCode;
    if (!customerCode) {
      const [firstName, ...rest] = (user.name || "Vendor").split(" ");
      const customer = await createCustomer({
        email: user.email,
        firstName: firstName || "Vendor",
        lastName: rest.join(" ") || "-",
      });
      customerCode = customer.customer_code;
      wallet.paystackCustomerCode = customerCode;
    }

    const dva = await createDedicatedVirtualAccount({ customerCode });
    wallet.dva = dva;
    await wallet.save();

    res.json({ success: true, data: serializeWallet(wallet) });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/wallet/stats ────────────────────────────────────────────────────
// Aggregated lead-generation figures for the wallet dashboard: lifetime and
// current-month lead spend/counts, top-up totals, and a zero-filled monthly
// spend series for the trend chart (?months=3|6|12, default 6).

export async function getWalletStats(req, res, next) {
  try {
    const wallet = await getOrCreateWallet(req.user.userId);

    const months = [3, 6, 12].includes(Number(req.query.months))
      ? Number(req.query.months)
      : 6;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const seriesStart = new Date(
      now.getFullYear(),
      now.getMonth() - (months - 1),
      1,
    );

    const [agg] = await WalletTransaction.aggregate([
      { $match: { walletId: wallet._id, status: "success" } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: "$type",
                amountKobo: { $sum: "$amountKobo" },
                count: { $sum: 1 },
              },
            },
          ],
          month: [
            { $match: { createdAt: { $gte: monthStart } } },
            {
              $group: {
                _id: "$type",
                amountKobo: { $sum: "$amountKobo" },
                count: { $sum: 1 },
              },
            },
          ],
          monthly: [
            { $match: { type: "debit", createdAt: { $gte: seriesStart } } },
            {
              $group: {
                _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
                spentKobo: { $sum: "$amountKobo" },
                leads: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const byType = (rows) => Object.fromEntries(rows.map((r) => [r._id, r]));
    const totals = byType(agg.totals);
    const month = byType(agg.month);

    // Fixed window, zero-filled so the chart never has gaps.
    const monthlyMap = new Map(
      agg.monthly.map((r) => [`${r._id.year}-${r._id.month}`, r]),
    );
    const monthly = Array.from({ length: months }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (months - 1) + i, 1);
      const row = monthlyMap.get(`${d.getFullYear()}-${d.getMonth() + 1}`);
      return {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        spentKobo: row?.spentKobo ?? 0,
        leads: row?.leads ?? 0,
      };
    });

    res.json({
      success: true,
      data: {
        totalSpentKobo: totals.debit?.amountKobo ?? 0,
        totalLeads: totals.debit?.count ?? 0,
        totalToppedUpKobo: totals.topup?.amountKobo ?? 0,
        topupsCount: totals.topup?.count ?? 0,
        monthSpentKobo: month.debit?.amountKobo ?? 0,
        monthLeads: month.debit?.count ?? 0,
        monthly,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/wallet/transactions ────────────────────────────────────────────

export async function getTransactions(req, res, next) {
  try {
    const wallet = await getOrCreateWallet(req.user.userId);
    const { page = 1, limit = 20, type, startDate, endDate } = req.query;

    const filter = { walletId: wallet._id };
    if (type && ["topup", "debit"].includes(type)) filter.type = type;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const [items, total] = await Promise.all([
      WalletTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      WalletTransaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        items: items.map((t) => ({
          id: t._id,
          type: t.type,
          amountKobo: t.amountKobo,
          balanceAfterKobo: t.balanceAfterKobo,
          status: t.status,
          channel: t.channel,
          description: t.description,
          createdAt: t.createdAt,
        })),
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── Lead-billing hook (not an HTTP endpoint) ────────────────────────────────
// Called from search.controller.js's chargeLead (POST /api/search/lead),
// fired the instant a buyer clicks "Chat on WhatsApp" on a search result
// card. `debited: false` (insufficient balance) is a no-op today — a drained
// wallet already keeps a vendor out of search results entirely via
// staffly-ai-backend's retrieval.service.js wallet-eligibility filter, so
// this path is a last-resort race (balance dropped between that filter
// running and the buyer actually clicking), not the primary gate.
export async function debitWalletForLead(vendorId, amountKobo, { leadId, description } = {}) {
  const wallet = await Wallet.findOneAndUpdate(
    { vendorId, balanceKobo: { $gte: amountKobo } },
    { $inc: { balanceKobo: -amountKobo } },
    { new: true },
  );
  if (!wallet) return { debited: false, reason: "insufficient_balance" };

  await WalletTransaction.create({
    walletId: wallet._id,
    vendorId,
    type: "debit",
    amountKobo,
    balanceAfterKobo: wallet.balanceKobo,
    reference: leadId,
    status: "success",
    channel: "lead",
    description: description ?? "Lead charge",
  });

  // Auto-recharge is fully wired here so it works the moment leads start
  // calling this — never fails the debit itself (already succeeded above),
  // only logs on failure (e.g. card declined).
  await maybeAutoRecharge(wallet);

  return { debited: true, wallet };
}

// ── Referral-bonus hook (not an HTTP endpoint) ──────────────────────────────
// Called from referral.service.js's creditPendingReferral, once the referred
// vendor verifies their email. Unlike debitWalletForLead there's no
// insufficient-balance case to guard against — crediting a wallet can't fail
// on the balance itself — so getOrCreateWallet (not a bare findOneAndUpdate)
// handles the rare case where the referrer somehow has no wallet row yet.
export async function creditWalletForReferral(vendorId, amountKobo, { referralId, description } = {}) {
  const wallet = await getOrCreateWallet(vendorId);
  wallet.balanceKobo += amountKobo;
  clearLowBalanceFlagIfRecovered(wallet);
  clearAutoRechargeFailureIfRecovered(wallet);
  await wallet.save();

  try {
    await WalletTransaction.create({
      walletId: wallet._id,
      vendorId,
      type: "topup",
      amountKobo,
      balanceAfterKobo: wallet.balanceKobo,
      reference: `referral_${referralId}`,
      status: "success",
      channel: "referral",
      description: description ?? "Referral bonus",
    });
  } catch (err) {
    // Duplicate reference — this referral was already credited (the
    // caller's `status: 'pending'` guard should already prevent this, but
    // the unique index is the real guarantee) — back out the balance bump
    // above rather than leave a double-credit with no matching ledger row.
    if (err.code === 11000) {
      wallet.balanceKobo -= amountKobo;
      await wallet.save();
      return { credited: false, reason: "already_credited" };
    }
    throw err;
  }

  return { credited: true, wallet };
}

// Failure/retry/notify policy for a failing auto-recharge (user-directed
// 2026-07-13):
//  - The first failed attempt of a new episode notifies the vendor right
//    away (in-app + PWA push, via notifyUser — "wallet" is already a
//    HIGH_URGENCY_TYPES entry in pushNotification.service.js).
//  - After that, retries happen silently every AUTO_RECHARGE_RETRY_INTERVAL_MS
//    (5h) — no notification on a retry that's still failing.
//  - Every AUTO_RECHARGE_NOTIFY_INTERVAL_MS (20h) that it's STILL failing,
//    one more notification goes out — a periodic check-in, not a change to
//    the retry cadence itself.
//  - Capped at AUTO_RECHARGE_MAX_NOTIFICATIONS (7) notifications per episode;
//    past that, retries continue silently forever (or until the charge
//    finally succeeds, or the vendor tops up manually — either ends the
//    episode, see clearAutoRechargeFailureIfRecovered above).
//  - A wallet that's been topped up (balance back at/above threshold, by
//    ANY means) is simply no longer eligible for the claim query below —
//    "won't auto-debit once topped up" falls out of that $expr check for
//    free, no separate flag needed.
const AUTO_RECHARGE_RETRY_INTERVAL_MS = 5 * 60 * 60 * 1000;
const AUTO_RECHARGE_NOTIFY_INTERVAL_MS = 20 * 60 * 60 * 1000;
const AUTO_RECHARGE_MAX_NOTIFICATIONS = 7;

// Fires when a debit drops the balance below the vendor's configured
// threshold (debitWalletForLead), AND periodically for a wallet already
// mid-failure-episode (autoRechargeRetry.job.js's sweep — the ONLY way a
// failure episode ever gets retried when no new lead happens to land). Both
// callers share this exact function so the retry-interval/notify-cadence
// policy lives in one place regardless of what triggered the attempt.
//
// Claims an atomic lock (autoRecharge.inFlight) before charging — without
// it, two triggers landing close together for the same vendor could each
// independently pass the eligibility checks below and each fire a separate
// charge_authorization call, double-charging the card. The SAME claim also
// enforces the 5-hour retry gate ($or below) and the balance-vs-threshold
// eligibility ($expr — two fields of one document, which a plain filter
// can't compare) — the whole thing happens in one atomic findOneAndUpdate,
// no window between "check" and "flip the flag" for a second concurrent
// call to land in. Same pattern as starterCreditGranted/
// lowBalanceLastNotifiedAt elsewhere in this file.
export async function maybeAutoRecharge(wallet) {
  const retryGateCutoff = new Date(Date.now() - AUTO_RECHARGE_RETRY_INTERVAL_MS);

  const claimed = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      "autoRecharge.enabled": true,
      "autoRecharge.authorizationCode": { $ne: null },
      "autoRecharge.topupKobo": { $gt: 0 },
      "autoRecharge.inFlight": { $ne: true },
      $expr: { $lt: ["$balanceKobo", "$autoRecharge.thresholdKobo"] },
      $or: [
        { "autoRecharge.failureFirstAt": null },
        { "autoRecharge.failureLastAttemptAt": { $lte: retryGateCutoff } },
      ],
    },
    { $set: { "autoRecharge.inFlight": true } },
    { new: true },
  );
  if (!claimed) return;

  // Read before this attempt's own bookkeeping touches it.
  const isFirstFailureAttempt = !claimed.autoRecharge.failureFirstAt;

  try {
    const user = await User.findById(claimed.vendorId).select("email");
    if (!user) return;

    const reference = `autorecharge_${claimed.vendorId}_${Date.now()}`;
    const transaction = await chargeAuthorization({
      authorizationCode: claimed.autoRecharge.authorizationCode,
      email: user.email,
      amountNaira: claimed.autoRecharge.topupKobo / 100,
      reference,
      metadata: { type: "wallet_topup", vendorId: claimed.vendorId.toString() },
    });

    if (transaction.status !== "success") {
      console.warn(`[auto-recharge] charge not successful for ${claimed.vendorId}: ${transaction.status}`);
      await recordAutoRechargeFailure(claimed, isFirstFailureAttempt);
      return;
    }

    // Reuse the same idempotent credit path the webhook/verify flow uses —
    // transaction.reference is the one we just generated above. That path
    // also runs clearAutoRechargeFailureIfRecovered, ending the episode once
    // the resulting balance clears the threshold.
    await creditWalletFromReference(reference);
  } catch (err) {
    console.error(`[auto-recharge] failed for wallet ${claimed._id}:`, err.message);
    await recordAutoRechargeFailure(claimed, isFirstFailureAttempt).catch((e2) =>
      console.error(`[auto-recharge] failure bookkeeping also failed for ${claimed._id}:`, e2.message),
    );
  } finally {
    // Always release the claim, success or failure — a declined card (or any
    // other error) must not permanently lock the wallet out of ever
    // auto-recharging again.
    await Wallet.updateOne(
      { _id: claimed._id },
      { $set: { "autoRecharge.inFlight": false } },
    );
  }
}

// Updates the failure-episode bookkeeping and, per the notify cadence
// documented above maybeAutoRecharge, decides whether THIS particular
// failure is one the vendor should actually be told about.
async function recordAutoRechargeFailure(claimed, isFirstFailureAttempt) {
  const now = new Date();
  const notifyCount = claimed.autoRecharge.failureNotifyCount ?? 0;
  const lastNotifiedAt = claimed.autoRecharge.lastFailureNotifiedAt;

  const shouldNotify =
    isFirstFailureAttempt ||
    (notifyCount < AUTO_RECHARGE_MAX_NOTIFICATIONS &&
      (!lastNotifiedAt ||
        now.getTime() - lastNotifiedAt.getTime() >= AUTO_RECHARGE_NOTIFY_INTERVAL_MS));

  const update = { "autoRecharge.failureLastAttemptAt": now };
  if (isFirstFailureAttempt) update["autoRecharge.failureFirstAt"] = now;
  if (shouldNotify) {
    update["autoRecharge.failureNotifyCount"] = notifyCount + 1;
    update["autoRecharge.lastFailureNotifiedAt"] = now;
  }
  await Wallet.updateOne({ _id: claimed._id }, { $set: update });

  if (!shouldNotify) return;

  try {
    await notifyUser(claimed.vendorId, {
      type: "wallet",
      title: "Auto-recharge failed",
      body: "We couldn't auto-recharge your Velte wallet — the card on file was declined. Update your card or top up manually to keep showing up in buyer searches.",
      url: `/${claimed.vendorId}/wallet`,
      tag: "auto-recharge-failed",
    });
  } catch (err) {
    console.error(`[auto-recharge] notify failed for ${claimed.vendorId}:`, err.message);
  }
}
