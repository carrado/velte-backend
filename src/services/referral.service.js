import User from '../models/Users.js';
import Referral from '../models/Referral.model.js';
import { creditWalletForReferral } from '../controllers/wallet/wallet.controller.js';
import { notifyUser } from './pushNotification.service.js';
import { generateUniqueReferralCode } from '../utils/referralCode.js';

export const REFERRAL_BONUS_KOBO = 100_000; // ₦1,000 — "for now", per the wallet-threshold precedent

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
 * Called after a referee's email verification succeeds (the anti-abuse
 * gate — a bare signup with no real email behind it never pays out). Finds
 * their pending Referral (if any), credits the referrer's wallet, marks it
 * credited, and notifies the referrer. A no-op for a vendor who wasn't
 * referred, or whose referral was already credited (idempotent by the
 * `status: 'pending'` filter — calling this twice is safe).
 */
export async function creditPendingReferral(refereeUser) {
  const referral = await Referral.findOne({
    refereeId: refereeUser._id,
    status: 'pending',
  });
  if (!referral) return;

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
