// Tiered per-lead pricing (per explicit request) — the LOWER a vendor's
// wallet balance, the MORE each lead costs, incentivizing bigger top-ups
// instead of small, frequent ones:
//   < ₦5,000            → ₦1,000/lead (100,000 kobo)
//   ₦5,000 – <₦10,000   → ₦700/lead (70,000 kobo)
//   ≥ ₦10,000           → ₦500/lead (50,000 kobo)
// Ordered highest-balance-first so leadCostForBalance's own linear scan
// returns on the first tier the balance actually clears. Determined by the
// CURRENT balance at the moment of charge, never a rate locked in at
// top-up time — a vendor's rate moves with their wallet as it drains,
// tier by tier, same as the old flat rate always did.
//
// Pulled out into its own module (not left inline in wallet.controller.js)
// specifically so walletLowBalance.job.js can import it too without a
// circular dependency — that file already gets imported BY
// wallet.controller.js (for LOW_BALANCE_KOBO), so the reverse import would
// cycle.
export const LEAD_TIERS = [
  { minBalanceKobo: 1_000_000, costKobo: 50_000 }, // ≥ ₦10,000 → ₦500/lead
  { minBalanceKobo: 500_000, costKobo: 70_000 }, // ₦5,000–₦9,999 → ₦700/lead
  { minBalanceKobo: 0, costKobo: 100_000 }, // < ₦5,000 → ₦1,000/lead
];

/** The per-lead rate that applies to a given wallet balance right now. */
export function leadCostForBalance(balanceKobo) {
  for (const tier of LEAD_TIERS) {
    if (balanceKobo >= tier.minBalanceKobo) return tier.costKobo;
  }
  return LEAD_TIERS[LEAD_TIERS.length - 1].costKobo;
}

/**
 * How many more leads a balance can still cover, capped at `cap` (default
 * 2) — callers of this only ever need to distinguish "0", "1", or "2+",
 * never an exact count (see walletLowBalance.job.js's own SMS trigger:
 * "covers at most 1 lead"), so this stops simulating once it hits the cap
 * rather than walking a large balance all the way down to zero. Ordinary
 * eligibility ("can this vendor afford even one more lead") is simpler
 * and doesn't need this — see MIN_LEAD_COST_KOBO below.
 */
export function leadsRemaining(balanceKobo, cap = 2) {
  let remaining = balanceKobo;
  let count = 0;
  while (count < cap) {
    const cost = leadCostForBalance(remaining);
    if (remaining < cost) break;
    remaining -= cost;
    count += 1;
  }
  return count;
}

// The most expensive tier's own rate — by construction (every OTHER tier's
// minBalanceKobo comfortably covers its own, cheaper costKobo), a balance
// clears MIN_LEAD_COST_KOBO if and only if it can afford at least one
// lead, at WHATEVER rate its own tier charges. This is what search-time
// wallet-eligibility filtering actually needs (store.controller.js here,
// plus staffly-ai-backend's and velte-super-admin's own mirrors) — a
// single flat floor, not the full tier table, since eligibility only ever
// asks "can they afford ONE more lead," never "which rate."
export const MIN_LEAD_COST_KOBO = LEAD_TIERS[LEAD_TIERS.length - 1].costKobo;
