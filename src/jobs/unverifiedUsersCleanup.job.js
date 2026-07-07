import User from "../models/Users.js";
import Referral from "../models/Referral.model.js";

// A signup that hasn't verified its email within this window is abandoned —
// the OTP itself dies after 10 minutes, so 7 days is many chances to come
// back via the resend path before the account (and its hold on the email
// and username) is released.
export const UNVERIFIED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Deletes abandoned unverified signups. Without this they sit in `users`
 * forever: locked out of login, but holding the email/username hostage in
 * register's resend-OTP path and polluting raw user counts.
 *
 * An unverified user can't have logged in, so they own no wallet, push
 * subscriptions, or notifications — the only side record signup creates is
 * a pending Referral row (see recordPendingReferral), which must go with
 * them: its unique refereeId index would otherwise block the same person
 * being referred again on a fresh signup, and status:"pending" is
 * guaranteed here because crediting only ever happens at verification.
 */
export async function cleanupUnverifiedUsers() {
  const cutoff = new Date(Date.now() - UNVERIFIED_MAX_AGE_MS);

  const staleUsers = await User.find({
    accountVerified: { $ne: true },
    createdAt: { $lt: cutoff },
  }).select("_id");

  if (!staleUsers.length) return;
  const staleIds = staleUsers.map((u) => u._id);

  // Referrals first — if the user delete then fails, the retry next run
  // still finds the user; the reverse order could orphan referral rows.
  const { deletedCount: referralCount } = await Referral.deleteMany({
    refereeId: { $in: staleIds },
  });
  const { deletedCount: userCount } = await User.deleteMany({
    _id: { $in: staleIds },
  });

  console.log(
    `[signup-cleanup] removed ${userCount} unverified account(s) older than 7 days` +
      (referralCount ? ` and ${referralCount} pending referral(s)` : ""),
  );
}
