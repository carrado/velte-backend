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

// New vendors get a one-time, non-refundable starter credit so they can see
// real leads land before ever having to trust the AI matching enough to pay
// for one — removes the cold-start "prepay with zero track record" barrier.
const STARTER_CREDIT_KOBO = 200_000; // ₦2,000

async function getOrCreateWallet(vendorId) {
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
    if (!Number.isFinite(amountNaira) || amountNaira < 100) {
      throw new AppError("amountNaira must be at least 100.", 400);
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
      },
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

// Shared credit path — called from verifyTopup (buyer-initiated poll) AND from
// the Paystack webhook (server-to-server, authoritative). Whichever gets there
// first wins; the unique index on WalletTransaction.reference makes the other
// a no-op instead of a double-credit.
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

  const wallet = await getOrCreateWallet(meta.vendorId);
  const amountKobo = transaction.amount; // Paystack already reports amount in kobo

  wallet.balanceKobo += amountKobo;

  // First successful card top-up captures a reusable authorization for
  // auto-recharge — never charged per-lead, only for future batched top-ups.
  const auth = transaction.authorization;
  if (auth?.reusable && auth.authorization_code) {
    wallet.autoRecharge.authorizationCode = auth.authorization_code;
    wallet.autoRecharge.last4 = auth.last4 ?? null;
    wallet.autoRecharge.cardType = auth.card_type ?? null;
  }

  await wallet.save();

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
    // Duplicate reference raced us (webhook + verify landed together) — the
    // balance update above already happened once per Paystack idempotency of
    // `transaction.amount`, so back it out to avoid a double-credit.
    if (err.code === 11000) {
      wallet.balanceKobo -= amountKobo;
      await wallet.save();
      return Wallet.findById(wallet._id);
    }
    throw err;
  }

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

    if (enabled && !wallet.autoRecharge.authorizationCode) {
      throw new AppError(
        "Top up with a card at least once before enabling auto-recharge.",
        400,
      );
    }

    if (enabled !== undefined) wallet.autoRecharge.enabled = !!enabled;
    // Zero is never meaningful here — "recharge when below ₦0" can never fire,
    // and "top up by ₦0" is a no-op — so both must be strictly positive, not
    // just non-negative.
    if (thresholdKobo !== undefined) {
      if (!Number.isFinite(thresholdKobo) || thresholdKobo <= 0) {
        throw new AppError("thresholdKobo must be greater than 0.", 400);
      }
      wallet.autoRecharge.thresholdKobo = thresholdKobo;
    }
    if (topupKobo !== undefined) {
      if (!Number.isFinite(topupKobo) || topupKobo <= 0) {
        throw new AppError("topupKobo must be greater than 0.", 400);
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
// Exported for the future searches/leads core (Velte Connect Bucket D) to call
// atomically inside its lead-creation transaction. Not wired to anything yet —
// there's no leads endpoint in this repo to call it. `debited: false` is the
// hook a future ranking layer uses to decide whether a vendor stays eligible
// for matching (see "Known gaps" in the teardown plan — the actual grace vs.
// hard-block policy on that signal is undecided, that's a matching-layer call,
// not a wallet one).
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

// Fires when a debit drops the balance below the vendor's configured
// threshold. Never called per-lead directly — batches into one recharge
// (spec §11) instead of charging the card on every lead.
async function maybeAutoRecharge(wallet) {
  const { enabled, authorizationCode, thresholdKobo, topupKobo } = wallet.autoRecharge;
  if (!enabled || !authorizationCode || topupKobo <= 0) return;
  if (wallet.balanceKobo >= thresholdKobo) return;

  try {
    const user = await User.findById(wallet.vendorId).select("email");
    if (!user) return;

    const reference = `autorecharge_${wallet.vendorId}_${Date.now()}`;
    const transaction = await chargeAuthorization({
      authorizationCode,
      email: user.email,
      amountNaira: topupKobo / 100,
      reference,
      metadata: { type: "wallet_topup", vendorId: wallet.vendorId.toString() },
    });

    if (transaction.status !== "success") {
      console.warn(`[auto-recharge] charge not successful for ${wallet.vendorId}: ${transaction.status}`);
      return;
    }

    // Reuse the same idempotent credit path the webhook/verify flow uses —
    // transaction.reference is the one we just generated above.
    await creditWalletFromReference(reference);
  } catch (err) {
    console.error(`[auto-recharge] failed for wallet ${wallet._id}:`, err.message);
  }
}
