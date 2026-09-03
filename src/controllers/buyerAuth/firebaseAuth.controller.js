import jwt from "jsonwebtoken";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Buyer from "../../models/Buyer.model.js";
import { grantCredits } from "../credits/credits.controller.js";
import {
  REFERRAL_CREDITS,
  REFERRAL_MAX_PER_BUYER,
  SIGNUP_CREDITS,
} from "../../config/credits.js";
import crypto from "crypto";
import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";

// Buyer sign-in via Firebase Auth (2026-08-26). Buyers have real accounts so
// their search conversations can be listed and reopened — see
// Buyer.model.js's own note on the direction this reverses.
//
// Firebase is the identity PROVIDER only. The browser signs in with Google
// through Firebase, gets a Firebase ID token, and POSTs it here; this
// verifies it and issues the `buyer_auth_token` cookie —
// `{ buyerId, type: "buyer" }`, same secret and lifetime as the vendor
// token. It is the ONLY thing that issues one: verifying a phone attaches a
// number to a session that already exists, and has never created one.
// Nothing downstream (verifyBuyerAuth here, buyerGuards.ts in the frontend,
// the conversation endpoints) knows or cares that Firebase was involved.
//
// ── Verified against Google's PUBLIC keys, with no service account ───────
//
// A Firebase ID token is an ordinary RS256 JWT signed by Google, so
// everything needed to verify one is public: the signing certificates, the
// issuer, and the project id. This started out on firebase-admin and a
// downloaded service-account key, and moved here when Google's
// `iam.disableServiceAccountKeyCreation` policy blocked issuing that key at
// all — but it stays here on merit, not as a workaround:
//
//   - There is no secret to hold. Nothing to paste into Render's env,
//     nothing to rotate, nothing to leak. The app doesn't run on GCP, so a
//     service-account key was always the awkward part of this.
//   - It drops firebase-admin, a large dependency used for one function.
//   - Dev and production verify identically with no per-environment key.
//
// What it gives up is `checkRevoked`, which needs admin credentials: a
// token from a session revoked in the last hour still verifies. Accepted
// deliberately for buyer sign-in on a shopping app — the token expires
// hourly on its own, and nothing here is a standing authorisation. Revisit
// if buyer accounts ever hold anything worth stealing.

const SESSION_TTL = "7d"; // matches the vendor auth_token

// Google's published signing keys for Firebase ID tokens. createRemoteJWKSet
// caches them and refetches only when a token arrives with a key id it
// hasn't seen — so this is one network call every few hours, not one per
// sign-in. Built once at module load: it holds no credentials and no
// per-project state, so there is nothing to initialise lazily.
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

// Duplicated from buyerAuth.controller.js rather than shared, deliberately
// kept identical — if one changes, change both.
function cookieOptions() {
  const isProd =
    process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  };
}

// POST /api/buyer-auth/firebase — { idToken }
// Issues the buyer session cookie. The only thing that does.
/** A short, unambiguous share code. Base32-ish alphabet with no 0/O/1/I, so a
 *  code read aloud or typed off a screenshot survives the trip. Collisions are
 *  caught by the unique index, and at 8 characters from a 32-symbol alphabet
 *  they are not a practical concern. */
function newReferralCode() {
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export async function firebaseSignIn(req, res, next) {
  try {
    const { idToken, referralCode } = req.body ?? {};
    if (!idToken || typeof idToken !== "string") {
      return next(new AppError("A sign-in token is required", 400));
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      return next(
        new AppError("Sign-in is not configured on this server", 500),
      );
    }

    let payload;
    try {
      // Every check that matters, and none of them optional:
      //   - signature, against the keys above;
      //   - `algorithms`, pinned to RS256 so a token can't arrive claiming
      //     "alg": "none" or an HMAC the JWKS would never sign;
      //   - `audience`, the project id — a valid Firebase token minted for
      //     SOMEONE ELSE'S project is still a valid Google-signed token, and
      //     this is the only thing that rejects it;
      //   - `issuer`, Firebase's own securetoken issuer for this project;
      //   - expiry, which jwtVerify enforces from `exp` on its own.
      ({ payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
        algorithms: ["RS256"],
        audience: projectId,
        issuer: `https://securetoken.google.com/${projectId}`,
      }));
    } catch (err) {
      // A malformed, expired or wrong-project token is the client's problem,
      // not a server fault. Logged because during a misconfiguration (a
      // FIREBASE_PROJECT_ID that doesn't match the frontend's) the
      // alternative is an unexplained 401 loop with nothing to go on.
      console.error("[buyer-auth] Firebase ID token rejected:", err.message);
      return next(new AppError("Could not verify that sign-in", 401));
    }

    // `sub` IS the Firebase uid on an ID token. Checked rather than assumed:
    // a token that verified but carries no subject identifies nobody, and
    // creating a Buyer keyed on undefined would be worse than refusing.
    const firebaseUid =
      typeof payload.sub === "string" && payload.sub ? payload.sub : null;
    if (!firebaseUid) {
      return next(new AppError("Could not verify that sign-in", 401));
    }
    // Firebase reports whether the provider actually confirmed the address.
    // Since the email is what links this sign-in to an existing
    // phone-verified buyer below, accepting an unverified one would let
    // someone claim another person's account by registering that address.
    if (payload.email && payload.email_verified === false) {
      return next(new AppError("That account's email isn't verified", 401));
    }

    const email =
      typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    const name = typeof payload.name === "string" ? payload.name : null;
    const avatar = typeof payload.picture === "string" ? payload.picture : null;

    // ── Which buyer is this, in strict order of confidence ──────────────
    //
    // 1. Someone already signed in with THIS Google account — that account
    //    has a home, use it. Checked first so two real accounts can never
    //    be merged just because a session happened to be open.
    // 2. Someone already holds this verified email — the same person
    //    arriving by a route that predates their Google sign-in.
    // 3. A session is open on a buyer with no Google identity yet — LINK to
    //    it rather than creating a second account (2026-08-27).
    //
    // Step 3 is the important one, and it fixes a real trap: by the time a
    // buyer is offered sign-in they very often ALREADY have a session, from
    // verifying a phone for a reach-out request. That buyer has no email,
    // so steps 1 and 2 both miss, and without this a fresh Buyer would be
    // created — leaving their conversations behind on the old one, where
    // the claim endpoint can't reach them either (it only adopts
    // conversations with no owner at all). The buyer would sign up exactly
    // as invited and land on an empty history.
    let buyer = await Buyer.findOne({ firebaseUid });
    if (!buyer && email) buyer = await Buyer.findOne({ email });
    if (!buyer && req.buyer?.buyerId) {
      const sessionBuyer = await Buyer.findById(req.buyer.buyerId);
      // Only when it has no Google identity of its own. One that does
      // belongs to a different Google account, and this token isn't it —
      // overwriting would hand this sign-in someone else's history.
      if (sessionBuyer && !sessionBuyer.firebaseUid) buyer = sessionBuyer;
    }

    if (buyer) {
      buyer.firebaseUid = firebaseUid;
      if (email) buyer.email = email;
      // Only fill a name/avatar that isn't already there — a returning
      // buyer who has since changed their Google picture shouldn't have
      // this route quietly rewriting their record on every sign-in.
      if (!buyer.name && name) buyer.name = name;
      if (!buyer.avatar && avatar) buyer.avatar = avatar;
      buyer.lastLoginAt = new Date();
      await buyer.save();
    } else {
      try {
        // Who sent them, resolved BEFORE the insert so the link is recorded
        // atomically with the account rather than patched on afterwards —
        // a second write here could fail and leave a referred buyer with no
        // referrer and a referrer with no bonus.
        //
        // A code that matches nobody is ignored in silence: a mistyped or
        // stale link should still let someone sign up, and telling them
        // their referral code was invalid at that moment helps no one.
        const referrer = referralCode
          ? await Buyer.findOne({ referralCode: String(referralCode).trim() })
              .select("_id referralGrants")
              .lean()
          : null;

        buyer = await Buyer.create({
          firebaseUid,
          email,
          name,
          avatar,
          referralCode: newReferralCode(),
          referredByBuyerId: referrer?._id ?? null,
          lastLoginAt: new Date(),
          // phone stays null — a number is asked for at the point a Buyer
          // Request actually needs one, not at sign-in (see
          // Buyer.model.js).
        });
      } catch (err) {
        // A sign-in button is exactly the thing people double-tap, and the
        // find-then-create above is not atomic: two requests can both miss
        // and both insert, with the partial unique index rejecting the
        // loser. That's a race, not a failure — the buyer it raced against
        // now exists, so read it back rather than showing an error for a
        // sign-in that in fact succeeded.
        if (err?.code !== 11000) throw err;
        buyer =
          (await Buyer.findOne({ firebaseUid })) ||
          (email ? await Buyer.findOne({ email }) : null);
        if (!buyer) throw err;
      }
    }

    // ── The signup credit grant (2026-08-31) ───────────────────────────
    //
    // Every buyer account starts with SIGNUP_CREDITS, once and only once.
    // Idempotent on the code rather than on "did we just create the row",
    // because the creation path above is deliberately race-tolerant: a
    // double-tapped sign-in button can reach here twice for the same buyer,
    // and the second must not grant a second batch.
    //
    // Keyed off the BUYER, so it is granted on the first sign-in of an
    // account that predates this — which is intended. An existing buyer who
    // has never had credits should get their fifteen, not be punished for
    // having signed up early.
    //
    // Never fatal: a buyer who signs in successfully must be signed in even
    // if the ledger is unreachable. They can be granted on their next visit.
    try {
      await grantCredits(buyer._id, "buyer", "signup", SIGNUP_CREDITS);
    } catch (err) {
      console.error("[firebase-auth] signup credit grant failed:", err?.message);
    }

    // ── The referral bonus ─────────────────────────────────────────────
    //
    // Paid to the REFERRER, once, when the person they sent creates an
    // account. Idempotent on the new buyer's id, so a double-tapped sign-in
    // that reaches this handler twice pays once — the same guarantee the
    // signup grant relies on.
    //
    // Read back off the buyer rather than from the local `referrer` above,
    // because this block also runs on a RETURNING buyer's sign-in and the
    // local variable only exists on the creation path. The idempotency code
    // is what makes running it every time harmless.
    //
    // Capped per referrer (REFERRAL_MAX_PER_BUYER) — paying on account
    // creation alone is farmable, and the cap is what bounds it.
    if (buyer.referredByBuyerId) {
      try {
        const referrerId = buyer.referredByBuyerId;
        const bumped = await Buyer.findOneAndUpdate(
          { _id: referrerId, referralGrants: { $lt: REFERRAL_MAX_PER_BUYER } },
          { $inc: { referralGrants: 1 } },
          { new: true },
        )
          .select("_id")
          .lean();
        // null means they are at the cap — or the row is gone. Either way
        // there is nothing to pay, and nothing to say about it here.
        if (bumped) {
          const { granted } = await grantCredits(
            referrerId,
            "buyer",
            `referral:${buyer._id}`,
            REFERRAL_CREDITS,
          );
          // The counter is incremented before the grant, so a grant that
          // turns out to be a duplicate (this handler re-entered) must give
          // the slot back or a referrer slowly loses headroom to retries.
          if (!granted) {
            await Buyer.updateOne(
              { _id: referrerId },
              { $inc: { referralGrants: -1 } },
            );
          }
        }
      } catch (err) {
        console.error("[firebase-auth] referral grant failed:", err?.message);
      }
    }

    // ── Link this buyer to their VENDOR account, if they have one ───────
    //
    // This sign-in creates a SEPARATE buyer document even for someone who is
    // already a vendor, and resolveActor prefers the buyer cookie when both
    // are present — so the two halves of one person are otherwise invisible
    // to each other. Built (2026-08-29) to carry a PLAN across that gap;
    // plans are retired (2026-08-31) and nothing is read across the link
    // today, since a vendor spends from their lead wallet and a buyer from
    // their credits. Kept because the hard part is proving both halves
    // belong to the same human, and that proof is what is recorded here.
    //
    // BOTH sides must have proven control of this address:
    //   - buyer side: Firebase says so (`email_verified === false` was
    //     rejected above).
    //   - vendor side: `accountVerified` is set only by entering an OTP
    //     emailed to it (controllers/auth/auth.js verify), and login is
    //     refused until it is.
    // The `accountVerified` filter is what makes that second half true.
    // Registration creates the row BEFORE verification and leaves it there,
    // so the collection contains rows holding addresses nobody proved they
    // own — someone can type a stranger's email into vendor signup. Matching
    // those would link a real buyer to a squatter's row. Both collections
    // store the address lowercased, so a direct match is sound.
    //
    // A LINK, not a merge — nothing else about either account is touched.
    // Best-effort: a failure here must never break a sign-in that otherwise
    // worked, because the cost is a missed entitlement (recoverable on the
    // next sign-in) versus locking someone out of their own history.
    if (email && !buyer.linkedVendorId) {
      try {
        const vendor = await User.findOne({ email, accountVerified: true })
          .select("_id")
          .lean();
        if (vendor) {
          // Both directions, because the entitlement lookup reads whichever
          // half is acting and must not have to scan for the other one.
          buyer.linkedVendorId = vendor._id;
          await buyer.save();
          await User.updateOne(
            { _id: vendor._id },
            { $set: { linkedBuyerId: buyer._id } },
          );
          console.log(
            `[buyer-auth] linked buyer ${buyer._id} <-> vendor ${vendor._id} on verified email`,
          );
        }
      } catch (err) {
        console.error("[buyer-auth] vendor link failed (ignored):", err);
      }
    }

    // See this file's own header for the claims and why they are shaped
    // this way.
    const token = jwt.sign(
      { buyerId: buyer._id, type: "buyer" },
      process.env.JWT_SECRET,
      { expiresIn: SESSION_TTL },
    );
    res.cookie("buyer_auth_token", token, cookieOptions());

    res.status(200).json({ success: true, data: { buyer } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
