import mongoose from "mongoose";

// 2026-08-18 — stripped back to the bare minimum per explicit product
// direction ("Just the Phone and OTP Verification, nothing buyers again on
// the system. Buyers still remain anonymous for now"): no longer an account
// model, just a phone-verification record.
//
// 2026-08-26 — REVERSED, per explicit product direction: buyers get real
// accounts, signed in with Google, so their search conversations can be
// listed and reopened like a chat history (SearchConversation.buyerId over
// in staffly-ai-backend already carries the ownership link). The identity
// fields deleted above are back, sourced from Google rather than typed by
// the buyer — there is still no password anywhere in this model, and still
// no buyer-entered profile to maintain.
//
// A buyer can now exist by EITHER route, which is why nothing here is
// required any more:
//   - Google sign-in     → firebaseUid + email, phone null until needed.
//   - Phone + OTP        → phone only, exactly as before (unchanged path).
//   - Both, once linked  → the same doc, matched on a verified email or a
//                          verified phone at sign-in time.
//
// Phone deliberately stays OPTIONAL rather than being collected during
// sign-up: a vendor replies to a Buyer Request over WhatsApp, so the number
// is genuinely needed there and nowhere else — it's still asked for at that
// exact moment (see the existing needs_identity flow), which keeps sign-in
// to one tap.
const buyerSchema = new mongoose.Schema(
  {
    // Was `required: true, unique: true` while phone+OTP was the only way in.
    // Both had to go for a Google-only buyer to exist at all — see the
    // partial index below for why `unique` couldn't simply move here.
    phone: {
      type: String,
      default: null,
      trim: true,
    },
    // A number being verified RIGHT NOW by an already-signed-in buyer
    // (2026-08-26). It can't be written straight to `phone`: that would mark
    // an unverified number as this account's contact the moment the code was
    // requested, and a vendor would reply on WhatsApp to a number nobody has
    // proven they own. Moves to `phone` only once the code checks out, and is
    // cleared either way.
    //
    // Only used on the signed-in path. A buyer with no session still verifies
    // through the original upsert-by-phone flow, where the Buyer document IS
    // the number and there is nothing to hold pending.
    pendingPhone: {
      type: String,
      default: null,
      trim: true,
    },
    // ── Buyer referrals (2026-08-31) ─────────────────────────────────
    //
    // Deliberately NOT the existing Referral collection, which is a
    // vendor→vendor mechanic end to end: both its sides are `ref: "User"`,
    // it pays `bonusKobo` into the lead wallet, and it only credits once the
    // referee has posted products. None of that maps onto a buyer, and a
    // refereeId pointing at the wrong collection would be a foreign key that
    // silently resolves to nothing.
    //
    // Two plain fields rather than a collection of their own: a buyer
    // referral has no lifecycle to track — it pays at account creation and
    // is done — so a status machine would model a state nothing can be in.

    /** This buyer's own code, handed out in their share link. Sparse so the
     *  unique index ignores the buyers who predate this and have none. */
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    /** Who referred them, if anyone. Set once at creation and never changed
     *  — a buyer can only ever have been referred once, by whoever's link
     *  they arrived through. */
    referredByBuyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      default: null,
    },

    /** How many referral bonuses this buyer has been paid.
     *
     *  Capped (see REFERRAL_MAX_PER_BUYER) because paying on ACCOUNT CREATION
     *  alone is farmable, and this codebase has already been bitten by
     *  exactly that: the vendor referral's own comment records a live leak in
     *  2026-08 where a bonus could be collected without the referee ever
     *  doing anything real. Buyer accounts are Google-backed, so each fake
     *  one costs a Google signup — friction, but not a wall. The cap is what
     *  bounds the damage. */
    referralGrants: {
      type: Number,
      default: 0,
      min: 0,
    },

    phoneOtp: {
      code: {
        type: Number,
        default: null,
      },
      expiresAt: {
        type: Date,
        default: null,
      },
    },
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    // The Firebase Auth `uid` — the join key for sign-in, never the email
    // (which a person can change on their Google account). Firebase's uid,
    // not Google's own subject id, because it stays the same for this person
    // across providers: adding Apple or phone sign-in later lands them on
    // this same document instead of a second one.
    firebaseUid: {
      type: String,
      default: null,
      trim: true,
    },
    email: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },
    // Straight from the Google profile, so the history sidebar can greet
    // someone by name without ever asking. Not authoritative for a Buyer
    // Request — that still carries the name the buyer gave the AI in the
    // conversation itself (see createBuyerRequestTool.ts), which is
    // deliberately what a vendor reads.
    name: {
      type: String,
      default: null,
      trim: true,
    },
    avatar: {
      type: String,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    // Which plan this buyer is on. A plain string rather than an enum so
    // retiring or renaming a tier can never make an existing buyer
    // unreadable — the frontend resolves an unknown value to Free (see
    // plans.ts planFor), which under-charges rather than locking anyone out.
    plan: {
      type: String,
      default: "free",
    },
    // When the current paid plan lapses. Null on Free and on any buyer
    // who has never paid. A paid plan is never downgraded by a job — see
    // config/buyerPlans.js effectivePlanId, which computes the real tier
    // from this date on every read, so there is no cron to miss and no
    // window where a paying buyer is locked out because one didn't fire.
    planExpiresAt: {
      type: Date,
      default: null,
    },
    // "monthly" or "yearly" — what they last bought. Display only (it
    // drives the renewal prompt); access is always computed from
    // planExpiresAt, never from this.
    planCycle: {
      type: String,
      default: null,
    },
    // The Paystack reference of the last plan purchase applied to this
    // account. This is the idempotency key: Paystack retries webhooks, and
    // without it a redelivered charge.success would extend the expiry a
    // second time and hand out a free month per retry. Must stay declared
    // in the schema — Mongoose strict mode silently DROPS a $set to an
    // undeclared path, which would make the guard a no-op that looks fine.
    lastPlanReference: {
      type: String,
      default: null,
    },
    // The vendor account belonging to the SAME PERSON, when there is one
    // (2026-08-29). Set at Google sign-in, and only ever from a Firebase-
    // VERIFIED email that matches a vendor's login address — a verified
    // email is proof of the same human, which an unverified one is not.
    //
    // Exists because a vendor can now hold a plan (see helpers/actorPlan.js)
    // while Google sign-in on /chat still creates a separate Buyer, and
    // resolveActor prefers the buyer cookie when both are present. Without
    // this link, a vendor who bought Velte Business and then signed in with
    // Google to get their history would be silently resolved as a brand-new
    // free buyer — metered at 10 searches having just paid for 400, and
    // shown their own plan as still purchasable.
    //
    // A LINK, never a merge: the two accounts stay separate documents with
    // their own conversations, watches and usage counters. All this carries
    // across is the ENTITLEMENT, because a plan is bought by a person, not
    // by a cookie.
    linkedVendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // NOTE: search-usage counters used to live here. They moved to their
    // own Usage collection (2026-08-29) once vendors needed metering too —
    // a vendor signs in with a different cookie and is not a Buyer at all,
    // so counters hanging off this document could never cover them. See
    // models/Usage.model.js.
  },
  {
    timestamps: true,
  },
);

// Partial indexes, not `unique: true` on the fields — same reasoning as
// Users.js's own phone index, and now for the same reason: once a field can
// legitimately be null on many documents, a plain unique index treats every
// null as a duplicate of every other null, and `sparse` doesn't help
// because Mongoose writes an explicit null rather than omitting the field.
// Comparing only documents where the value is an actual string gives real
// uniqueness on real values and lets any number of null-valued buyers
// coexist.
//
// MIGRATION: the old plain `unique: true` index on `phone` still exists on
// any database created before 2026-08-26, and Mongoose does NOT drop an
// index it no longer declares. Left in place it rejects the second
// null-phone (i.e. Google-only) buyer, which is exactly the case this
// change exists to allow. Run scripts/fix-buyer-indexes.js once per
// environment before the first Google sign-in.
buyerSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string" } } },
);
buyerSchema.index(
  { firebaseUid: 1 },
  {
    unique: true,
    partialFilterExpression: { firebaseUid: { $type: "string" } },
  },
);
buyerSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string" } } },
);

// Strip the OTP out of any serialized response — belt-and-suspenders in
// case a query forgets to .select() it out.
buyerSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.phoneOtp;
    return ret;
  },
});

export default mongoose.model("Buyer", buyerSchema);
