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

// SIGNUP_CREDITS removed (2026-09-06) — a buyer account no longer gets a
// bonus grant on creation. Alongside this, guest pricing was unified with
// signed-in pricing and the guest allowance raised to 10 (see the
// frontend's credits.ts) — a guest now gets the full, real-price allowance
// up front instead of a smaller discounted one plus a bonus for signing in,
// so there is nothing left for a signup grant to add. Do not re-add this
// without also revisiting that guest-side change; the two were one decision.

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

// ── Vendor starting credits, by catalogue size (2026-08-31) ────────────────
//
// A vendor is not a buyer with a different cookie: they arrive already having
// done work for Velte. Every offering they upload is what the discovery engine
// actually matches against, so a deep catalogue is the single most valuable
// thing a vendor can give us — and paying for it in the currency they will
// spend on search is the cheapest acquisition Velte has. A vendor with twenty
// listings is worth far more than four buyers, and gets twenty times a
// buyer's signup grant.
//
// Ordered highest-first so `catalogGrantFor`'s linear scan returns on the
// first tier the count actually clears. (utils/leadPricing.js used to hold a
// LEAD_TIERS table of the same shape; lead pricing went flat on 2026-09-03,
// so this is now the only tier table left in the repo.)
//
// These are TARGETS, not increments. A vendor holds whatever their tier says,
// so crossing 10 or 20 tops them up by the DIFFERENCE and never re-pays what
// they already have (see syncVendorCatalogCredits). That is what makes the
// grant an ongoing incentive to keep listing rather than a one-shot at
// whatever moment we happened to look — a vendor who signs up with three
// products and grows to twenty ends on 200, exactly as if they had arrived
// with twenty.
//
// Not farmable by delete-and-repost: each tier is granted once ever, under its
// own idempotency code, so a catalogue that shrinks and regrows pays nothing
// the second time. (Wallet.productBonusGrantedCount exists for exactly this
// attack on the product-listing bonus; this is the same guard by another
// mechanism.)
export const VENDOR_CATALOG_GRANTS = [
  { minOfferings: 20, credits: 200 },
  { minOfferings: 10, credits: 100 },
  { minOfferings: 0, credits: 50 },
];

/** The tier a vendor with `count` offerings has earned. Never null — the last
 *  row's floor is 0, so a vendor with an empty catalogue still starts with
 *  something to spend. */
export function catalogGrantFor(count) {
  const n = Number.isFinite(count) ? count : 0;
  return (
    VENDOR_CATALOG_GRANTS.find((tier) => n >= tier.minOfferings) ??
    VENDOR_CATALOG_GRANTS[VENDOR_CATALOG_GRANTS.length - 1]
  );
}

/** The idempotency code a tier's grant is recorded under. Keyed on the tier's
 *  own floor rather than its position, so reordering or inserting a tier can
 *  never make an already-paid grant look unpaid. */
export function catalogGrantCode(tier) {
  return `catalog:${tier.minOfferings}`;
}
