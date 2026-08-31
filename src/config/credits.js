// Credit GRANT amounts (2026-08-31).
//
// The split of ownership here mirrors how plan prices used to work, and for
// the same reason:
//
//   COSTS (what an action spends) live in the frontend's
//   src/lib/server/ai/credits.ts and travel over the wire on each consume,
//   because the gate, the refusal copy and the credit gauge all read them and
//   one table that cannot disagree with itself beats two that drift.
//
//   GRANTS live HERE, because they are applied server-side inside the flows
//   that earn them — account creation, referral completion, a verified
//   Paystack top-up. A grant amount that arrived from the client would be a
//   grant amount the client could choose.
//
// Keep these in step with the same-named constants in the frontend's
// credits.ts, which is what the pricing UI shows. They are the numbers a
// buyer is promised; these are the numbers they get.

/** Handed to every buyer account on creation, once. */
export const SIGNUP_CREDITS = 15;

/** Handed to the REFERRER when someone they referred creates an account.
 *  The only valve in a system with no monthly reset. */
export const REFERRAL_CREDITS = 5;

/** How many referral bonuses one buyer can ever be paid.
 *
 *  A bonus that pays on ACCOUNT CREATION alone is farmable — and this
 *  codebase has been bitten by that shape before: see Referral.model.js, which
 *  records a live 2026-08 leak where a vendor collected referral money without
 *  the referee ever listing anything. Buyer accounts are Google-backed, so
 *  each fake one costs a Google signup, but that is friction rather than a
 *  wall.
 *
 *  Ten caps the loss at 50 credits per determined abuser while leaving every
 *  genuine sharer far more headroom than they will use. Raise it only
 *  alongside a real activity gate on the referee. */
export const REFERRAL_MAX_PER_BUYER = 10;
