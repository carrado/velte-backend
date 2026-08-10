import User from '../models/Users.js';
import Referral from '../models/Referral.model.js';
import Product from '../models/Product.model.js';
import { creditWalletForReferral } from '../controllers/wallet/wallet.controller.js';
import { notifyUser } from './pushNotification.service.js';
import { generateUniqueReferralCode } from '../utils/referralCode.js';

export const REFERRAL_BONUS_KOBO = 100_000; // ₦1,000 — "for now", per the wallet-threshold precedent

// Real leakage found live (2026-08-10, 25 vendors on the platform): email
// verification alone was the only gate, so a vendor with a drained wallet
// could refer a fresh (or friend's) account, verify its email, and collect
// ₦1,000 without the referee ever listing a single product — pure
// self-dealing, no real catalog growth behind it. Require the referee to
// have actually posted a real number of listings too. A LIVE count (not a
// monotonic counter like the product-listing bonus deliberately uses) is
// fine here specifically because this credit is a one-time idempotent event
// (Referral.status flips pending -> credited exactly once, guarded below) —
// there's no repeatable delete-and-recreate farming loop to worry about the
// way there is for a per-product reward.
export const REFERRAL_CREDIT_MIN_PRODUCTS = 4;

/**
 * Called once, at signup, before the new user is saved. Always assigns a
 * fresh referral code (every vendor gets one, whether or not they ever
 * refer anyone) and, if `referralCodeInput` matches a real vendor, sets
 * `referredBy` on the new user. An invalid/typo'd code is silently ignored —
 * it must never block signup itself.
 *
 * Returns the referral info needed to record a pending Referral doc AFTER
 * the new user has been saved (and so has a real `_id`) — see
 * recordPendingReferral. Returns null when there's nothing to record.
 */
export async function prepareReferralForSignup(newUser, referralCodeInput) {
  newUser.referralCode = await generateUniqueReferralCode(User);

  if (!referralCodeInput) return null;
  const code = String(referralCodeInput).trim().toUpperCase();
  if (!code) return null;

  const referrer = await User.findOne({ referralCode: code }).select('_id');
  if (!referrer) return null; // invalid/unknown code — not an error, just no referral

  newUser.referredBy = referrer._id;
  return { referrerId: referrer._id, code };
}

/** Call after `newUser.save()` — needs a real `_id` for `refereeId`. */
export async function recordPendingReferral(newUser, referralInfo) {
  if (!referralInfo) return;
  try {
    await Referral.create({
      referrerId: referralInfo.referrerId,
      refereeId: newUser._id,
      code: referralInfo.code,
      status: 'pending',
      bonusKobo: REFERRAL_BONUS_KOBO,
    });
  } catch (err) {
    // Unique index on refereeId — a genuine race (shouldn't happen, one
    // signup per user) is the only thing that hits this; anything else
    // should surface.
    if (err.code !== 11000) throw err;
  }
}

/**
 * Called both right after a referee's email verification succeeds AND after
 * every product they create (see auth.js's verifyEmail and
 * product.controller.js's createProduct) — either call is a cheap no-op
 * until both real gates are satisfied: a verified email (enforced upstream —
 * an unverified account can't even log in to post a product, see auth.js's
 * login check) AND at least REFERRAL_CREDIT_MIN_PRODUCTS real listings
 * (checked here). Finds the referee's pending Referral (if any), and only
 * once the product-count gate also passes: credits the referrer's wallet,
 * marks it credited, and notifies the referrer. A no-op for a vendor who
 * wasn't referred, whose referral was already credited, or who hasn't
 * posted enough listings yet — idempotent by the `status: 'pending'` filter,
 * safe to call as often as either trigger point fires.
 */
export async function creditPendingReferral(refereeUser) {
  const referral = await Referral.findOne({
    refereeId: refereeUser._id,
    status: 'pending',
  });
  if (!referral) return;

  const productCount = await Product.countDocuments({ vendorId: refereeUser._id });
  if (productCount < REFERRAL_CREDIT_MIN_PRODUCTS) return;

  const refereeName = refereeUser.company?.name || refereeUser.name;

  await creditWalletForReferral(referral.referrerId, referral.bonusKobo, {
    referralId: referral._id,
    description: `Referral bonus — ${refereeName} joined`,
  });

  referral.status = 'credited';
  referral.creditedAt = new Date();
  await referral.save();

  try {
    await notifyUser(referral.referrerId, {
      type: 'referral',
      title: 'Referral bonus earned!',
      body: `${refereeName} joined Velte using your referral code — ₦${(referral.bonusKobo / 100).toLocaleString('en-NG')} has been added to your wallet.`,
      url: `/${referral.referrerId}/referrals`,
      tag: 'referral-credited',
    });
  } catch (err) {
    console.error('[referral] notify failed:', err.message);
  }
}
