// ONE PRICE, FOR EVERYBODY: ₦1,000 per lead (2026-09-03).
//
// Replaced three balance-tiers — the LOWER a vendor's balance, the MORE each
// lead cost (₦500 / ₦700 / ₦1,000), meant to reward bigger top-ups. It did
// something else as well. A vendor sitting on ₦10,500 who spent ₦600 dropped
// a tier and paid ₦200 more on EVERY lead afterwards: ₦4,000 over twenty
// leads, to save ₦600. Invisible at the moment of the decision, and it
// punished using the product.
//
// Everything built to contain that — the 30-day credit-spend window, the
// tierBalanceKobo aggregate in wallet.controller.js, the lastCreditPurchaseAt
// short-circuit — existed only because the price moved with the balance. A
// flat price deletes the problem rather than managing it, and all of that
// machinery went with this change.
//
// It reads as a rise: everyone now pays what only the lowest-balance vendors
// used to. It is not one in practice, because it shipped alongside
// charge-on-CONTACT (see search.controller.js's chargeLead). A vendor is no
// longer billed for accepting a buyer request that goes nowhere — only for a
// buyer who actually reached them. Higher per lead, far fewer leads charged.
//
// Mirrored in the velte frontend's services/wallet.ts, plus the standalone
// staffly-ai-backend's LEAD_COST_KOBO env var and velte-super-admin's own
// copies — keep them in sync until the price is served from the wallet/stats
// response instead. One number is a far easier thing to keep in sync than a
// tier table, which is part of the point.
export const LEAD_COST_KOBO = 100_000; // ₦1,000

/** The per-lead rate. Takes no balance any more and returns a constant, but
 *  stays a function so call sites read the same, and so there is one obvious
 *  place to put variable pricing back if it ever returns. */
export function leadCost() {
  return LEAD_COST_KOBO;
}

// What a vendor needs available to be charged for one lead. The same number
// as the rate now that there is only one rate — kept as its own name because
// "what does a lead cost" and "can this vendor afford one" are different
// questions asked by different callers (store.controller.js's search-time
// eligibility filter, wallet.controller.js's canAffordLead), and only the
// first of them is a price.
export const MIN_LEAD_COST_KOBO = LEAD_COST_KOBO;

/**
 * How many more leads a balance can still cover, capped at `cap` (default 2)
 * — callers only ever need to distinguish "0", "1", or "2+" (see
 * walletLowBalance.job.js's SMS trigger: "covers at most 1 lead"), never an
 * exact count.
 *
 * A plain divide now that the price is flat; it used to simulate the drain
 * tier by tier, because each lead could cost more than the one before it.
 * Clamped at 0 so a negative balance — reachable under charge-on-contact,
 * which lets a connection through even when the wallet moved after the
 * accept — reports none rather than a negative count.
 */
export function leadsRemaining(balanceKobo, cap = 2) {
  return Math.max(0, Math.min(Math.floor(balanceKobo / LEAD_COST_KOBO), cap));
}
