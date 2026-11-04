// Vendor payout onboarding — the settlement destination for money a vendor
// earns from cart checkout.
//
// Velte holds a buyer's payment and releases it to the vendor after the order
// is confirmed, so settlement is a TRANSFER out of Velte's Paystack balance,
// not a subaccount split at charge time (a split pays the vendor the instant
// the card clears, which is exactly what escrow exists to prevent). What a
// vendor needs on file is therefore a transfer recipient, and a product is
// only checkout-able once they have one.
//
// The vendor never types their account NAME. They give a bank and a number;
// Paystack's /bank/resolve says who owns it. A typo'd number fails at resolve
// rather than quietly becoming a recipient that pays a stranger.

import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  listBanks,
  resolveAccountNumber,
  createTransferRecipient,
} from "../../services/paystack.service.js";

// The Nigerian bank list changes a few times a year, and every vendor opening
// the payout form would otherwise spend a Paystack round-trip on it. Cached in
// process: a cold start re-fetches, which is often enough.
const BANKS_TTL_MS = 24 * 60 * 60 * 1000;
let banksCache = null;
let banksCachedAt = 0;

async function getCachedBanks() {
  if (banksCache && Date.now() - banksCachedAt < BANKS_TTL_MS) return banksCache;
  banksCache = await listBanks();
  banksCachedAt = Date.now();
  return banksCache;
}

// What the vendor's own dashboard gets back. The full account number is never
// returned once stored — the vendor already knows it, and anything that reads
// a user shouldn't be handed one.
function presentPayout(payout) {
  if (!payout?.recipientCode) return null;
  return {
    bankCode: payout.bankCode,
    bankName: payout.bankName,
    accountNumberMasked: `******${String(payout.accountNumber).slice(-4)}`,
    accountName: payout.accountName,
    verifiedAt: payout.verifiedAt,
  };
}

// ── GET /api/payouts/banks ───────────────────────────────────────────────────

export async function getBanks(req, res, next) {
  try {
    res.json({ success: true, data: { banks: await getCachedBanks() } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/payouts ─────────────────────────────────────────────────────────

export async function getPayoutAccount(req, res, next) {
  try {
    const user = await User.findById(req.user.userId).select("+payout");
    if (!user) throw new AppError("User not found.", 404);

    res.json({ success: true, data: { payout: presentPayout(user.payout) } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/payouts/resolve ────────────────────────────────────────────────
// Name-only preview so the vendor can confirm the account BEFORE anything is
// stored. Creates no recipient and touches no user document.
//
// Rate-limited harder than saving, not more softly: saving is a once-ever act
// that writes something visible, while this is cheap to repeat and its entire
// output is "who owns this account number" — the shape of thing worth
// enumerating. `save` re-resolves server-side anyway, so a tampered preview
// buys nothing.

export async function resolveAccount(req, res, next) {
  try {
    const bankCode = String(req.body?.bankCode ?? "").trim();
    const accountNumber = String(req.body?.accountNumber ?? "").trim();

    if (!bankCode) throw new AppError("Select your bank.", 400);
    if (!/^\d{10}$/.test(accountNumber)) {
      throw new AppError("Account number must be 10 digits.", 400);
    }

    const banks = await getCachedBanks();
    if (!banks.some((b) => b.code === bankCode)) {
      throw new AppError("That bank isn't supported for payouts.", 400);
    }

    let resolved;
    try {
      resolved = await resolveAccountNumber({ accountNumber, bankCode });
    } catch {
      throw new AppError(
        "We couldn't find that account. Check the number and bank.",
        400,
      );
    }

    res.json({ success: true, data: { accountName: resolved.accountName } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/payouts ────────────────────────────────────────────────────────
// Body: { bankCode, accountNumber }. Resolves the name, creates the transfer
// recipient, and stores all three. Replacing an existing account overwrites it.

export async function savePayoutAccount(req, res, next) {
  try {
    const bankCode = String(req.body?.bankCode ?? "").trim();
    const accountNumber = String(req.body?.accountNumber ?? "").trim();

    if (!bankCode) throw new AppError("Select your bank.", 400);
    if (!/^\d{10}$/.test(accountNumber)) {
      throw new AppError("Account number must be 10 digits.", 400);
    }

    const banks = await getCachedBanks();
    const bank = banks.find((b) => b.code === bankCode);
    if (!bank) throw new AppError("That bank isn't supported for payouts.", 400);

    const user = await User.findById(req.user.userId).select("+payout");
    if (!user) throw new AppError("User not found.", 404);

    // Re-saving the same account is a no-op rather than a second recipient:
    // Paystack doesn't dedupe these, and an orphaned recipient is a second
    // live payout destination for the same vendor.
    if (
      user.payout?.recipientCode &&
      user.payout.bankCode === bankCode &&
      user.payout.accountNumber === accountNumber
    ) {
      res.json({ success: true, data: { payout: presentPayout(user.payout) } });
      return;
    }

    // Both of these are Paystack calls against a number the vendor just typed,
    // so their failure is a normal outcome, not a server fault — a wrong number
    // resolves to nothing and must read as "check the number", never a 500.
    let resolved;
    try {
      resolved = await resolveAccountNumber({ accountNumber, bankCode });
    } catch {
      throw new AppError(
        "We couldn't find that account. Check the number and bank and try again.",
        400,
      );
    }

    let recipientCode;
    try {
      recipientCode = await createTransferRecipient({
        accountName: resolved.accountName,
        accountNumber,
        bankCode,
      });
    } catch {
      throw new AppError(
        "We couldn't set up payouts to that account. Please try again.",
        502,
      );
    }

    user.payout = {
      bankCode,
      bankName: bank.name,
      accountNumber,
      accountName: resolved.accountName,
      recipientCode,
      verifiedAt: new Date(),
    };
    await user.save();

    res.json({ success: true, data: { payout: presentPayout(user.payout) } });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/payouts ──────────────────────────────────────────────────────
// Removing the account stops the vendor's products being checkout-able. It does
// NOT touch money already owed — a pending payout still has its recipient code
// on the order it belongs to.

export async function removePayoutAccount(req, res, next) {
  try {
    const user = await User.findById(req.user.userId).select("+payout");
    if (!user) throw new AppError("User not found.", 404);

    user.payout = {};
    await user.save();

    res.json({ success: true, message: "Payout account removed." });
  } catch (err) {
    next(err);
  }
}
