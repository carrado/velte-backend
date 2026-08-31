// Buyer plan PRICES — the money authority (2026-08-29).
//
// Deliberately not shared with the frontend's plans.ts the way quotas are.
// The split is on purpose and worth understanding before changing it:
//
//   QUOTAS  — the frontend sends every tier's allowance and this repo picks
//             the row matching the buyer's own stored plan. Safe, because the
//             caller decides what a tier is worth, never which tier applies.
//   PRICES  — the amount actually charged. That cannot be supplied by the
//             caller at all, because the caller also names the plan being
//             bought; one compromised or buggy caller would otherwise sell
//             Velte Business for a naira. So it lives here, server-side, and
//             the frontend READS it (GET /buyer-billing/plans) for display
//             rather than asserting it.
//
// Keep the naira figures in step with src/lib/server/ai/plans.ts over in the
// frontend, which carries the same numbers for display fallback. If the two
// ever disagree, THIS file is what the buyer is actually charged.

// Kobo, because that's what money is stored as everywhere else in this repo
// (see Wallet.balanceKobo) and rounding naira twice is how you end up
// charging someone ₦1,999.99.
export const BUYER_PLANS = {
  plus: {
    id: "plus",
    name: "Velte Plus",
    monthlyKobo: 350_000, // ₦3,500
    yearlyKobo: 3_500_000, // ₦35,000
  },
};

// Velte Business was withdrawn on 2026-08-31 — it had no feature Plus didn't,
// only larger quotas, and a tier that can't be justified makes the ones
// beside it look padded too. Removed from here FIRST, because this file is
// what checkout can actually sell: leaving the row would keep it purchasable
// long after it stopped being offered. The frontend maps the retired id to
// Plus on read (see its plans.ts RETIRED_PLANS) so anyone already holding it
// is never silently dropped to Free.

// "free" is not sellable — it's what a buyer already has, and what an
// expired paid plan falls back to.
export const SELLABLE_PLAN_IDS = Object.keys(BUYER_PLANS);

export const CYCLES = {
  monthly: { id: "monthly", days: 30, field: "monthlyKobo" },
  yearly: { id: "yearly", days: 365, field: "yearlyKobo" },
};

/** The price in kobo for a plan+cycle, or null when either is unknown. */
export function priceKoboFor(planId, cycle) {
  const plan = BUYER_PLANS[planId];
  const spec = CYCLES[cycle];
  if (!plan || !spec) return null;
  const kobo = plan[spec.field];
  return Number.isInteger(kobo) && kobo > 0 ? kobo : null;
}

/**
 * When a plan bought now should lapse.
 *
 * Extends from the CURRENT expiry when one is still in the future, so a
 * buyer who renews early keeps the time they already paid for instead of
 * having it silently overwritten — the kind of quiet theft that generates
 * support tickets and refund requests.
 */
export function expiryFrom(cycle, currentExpiry) {
  const spec = CYCLES[cycle];
  if (!spec) return null;
  const now = Date.now();
  const base =
    currentExpiry && new Date(currentExpiry).getTime() > now
      ? new Date(currentExpiry).getTime()
      : now;
  return new Date(base + spec.days * 24 * 60 * 60 * 1000);
}

/**
 * How much plan a tier id represents, for comparing two of them.
 *
 * The monthly price IS the ranking — a tier that costs more is more plan,
 * and deriving it from the price table means adding a tier never needs a
 * hand-maintained order that can silently fall out of step with it.
 *
 * Everything unpurchasable ranks 0: "free", the "vendor" sentinel, an
 * unknown or retired id. That is deliberate — 0 means "nothing was bought",
 * which is exactly what the comparison needs to know.
 */
export function planRank(planId) {
  return BUYER_PLANS[planId]?.monthlyKobo ?? 0;
}

/**
 * The plan a buyer is ACTUALLY on right now, accounting for expiry.
 *
 * Computed rather than stored, and never written back on read: a lapsed plan
 * reverts by arithmetic, so there is no cron to run and no window where a
 * buyer is charged-but-downgraded because a job didn't fire. The stored
 * `plan` field is what they bought; this is what they currently have.
 */
export function effectivePlanId(buyer) {
  const stored = buyer?.plan ?? "free";
  if (stored === "free") return "free";
  if (!BUYER_PLANS[stored]) return "free";
  const expiry = buyer?.planExpiresAt;
  if (!expiry) return "free";
  return new Date(expiry).getTime() > Date.now() ? stored : "free";
}
