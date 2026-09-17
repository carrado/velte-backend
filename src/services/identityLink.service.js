import Buyer from "../models/Buyer.model.js";
import User from "../models/Users.js";

// Shared by both login surfaces (2026-09-16) — vendor password login
// (controllers/auth/auth.js's loginAsVendor) and buyer Google sign-in
// (controllers/buyerAuth/firebaseAuth.controller.js's firebaseSignIn).
//
// Extracted from what used to be firebaseAuth.controller.js's own inline
// linking block (added 2026-08-29) — that block only ever ran on the BUYER
// side, so a vendor who logged into the dashboard first, with a browser
// that separately held an unrelated buyer's `buyer_auth_token` cookie, had
// nothing checking whether the two belonged to the same person at all.
// Found live: a vendor signed in under one email inherited a completely
// different Google account's chat history and credits, because nothing
// ever verified the two cookies matched. Promoting this from "a
// background DB link write" to "the thing BOTH logins call before setting
// cookies" is what closes that — see identityLink.service.js's callers for
// the cookie-pairing/clearing logic itself, which lives in each
// controller (cookie shape differs slightly between the two).
//
// BOTH sides must have independently proven control of the email before a
// link is trusted:
//   - buyer side: Firebase's own `email_verified` claim.
//   - vendor side: `accountVerified` — set only by entering the OTP mailed
//     to that address at signup (controllers/auth/auth.js's verify).
// Registration creates the vendor row BEFORE verification and leaves it
// there, so an unverified vendor row can hold an address nobody has
// actually proven — the accountVerified filter is what keeps a real
// buyer from ever being linked to a squatted row. Both collections store
// the address lowercased, so a direct equality match is sound.

/** The verified vendor for this email, if one exists — null otherwise.
 *  Never throws; a lookup failure here must not break a sign-in that
 *  otherwise worked. */
export async function findVerifiedVendorByEmail(email) {
  if (!email) return null;
  try {
    return await User.findOne({ email, accountVerified: true })
      .select("_id email")
      .lean();
  } catch (err) {
    console.error("[identity-link] vendor lookup failed (ignored):", err);
    return null;
  }
}

/** The buyer for this email, if one exists — null otherwise. No separate
 *  "verified" filter on the buyer side: a Buyer document only ever comes
 *  from Firebase sign-in, which already required Google's own
 *  email_verified claim to reach this codebase at all (see
 *  firebaseSignIn's own rejection of unverified Firebase emails). */
export async function findBuyerByEmail(email) {
  if (!email) return null;
  try {
    return await Buyer.findOne({ email }).select("_id email linkedVendorId").lean();
  } catch (err) {
    console.error("[identity-link] buyer lookup failed (ignored):", err);
    return null;
  }
}

/** Writes the link both ways when it isn't already recorded. A LINK, not a
 *  merge — nothing else about either account is touched. Idempotent and
 *  best-effort: safe to call on every sign-in regardless of whether the
 *  link already exists. */
export async function linkVerifiedAccounts({ buyerId, vendorId }) {
  if (!buyerId || !vendorId) return;
  try {
    await Buyer.updateOne(
      { _id: buyerId, linkedVendorId: { $ne: vendorId } },
      { $set: { linkedVendorId: vendorId } },
    );
    await User.updateOne(
      { _id: vendorId, linkedBuyerId: { $ne: buyerId } },
      { $set: { linkedBuyerId: buyerId } },
    );
  } catch (err) {
    console.error("[identity-link] link write failed (ignored):", err);
  }
}
