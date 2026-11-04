// Prices for every new paid thing in docs/velte-platform-plan.md Phase 0.5.
//
// Q1 / Q2 (2026-10-15): Buyer Premium ₦5,000 / Vendor Enterprise ₦10,000
// monthly. Yearly is 10× monthly (two months free) so Paystack plans can
// be created; change the annual figures here if that discount should move.

export const SUBSCRIPTION_PRICES_NGN = {
  buyer_premium: { monthly: 5_000, annual: 50_000 },
  vendor_enterprise: { monthly: 10_000, annual: 100_000 },
};

/** Hours a buyer has to confirm or dispute after delivery before a
 *  silent order can release, and only if delivery evidence is on the
 *  order. Reminders go out in the last 12 hours of this window. */
export const CONFIRMATION_WINDOW_HOURS = 48;

export function subscriptionPriced(plan, interval) {
  const row = SUBSCRIPTION_PRICES_NGN[plan];
  const key = interval === "yearly" ? "annual" : interval;
  const amount = row?.[key] ?? null;
  return Number.isInteger(amount) && amount > 0;
}

/** A KYC re-check after the first (which Velte absorbs — Q8). */
export const KYC_RECHECK_CREDITS = 8;

// Q8: Ninja (ninja.ng). Published pay-as-you-go, Oct 2026
// (https://www.ninja.ng/pricing/). Velte absorbs the first check per
// account; these are what that first check costs us.
//
// Launch flow is hosted KYC with selfie_required and liveness_required
// off (2026-10-15). Ninja bills one hosted price either way; liveness is
// a flag on the same flow, not a cheaper product. The ₦100 lookup does
// not compare a photo.
export const KYC_PROVIDER = "ninja";
export const KYC_LIVENESS = false;
export const KYC_NIN_NGN = 100;
export const KYC_NIN_HOSTED_NGN = 300; // registry + selfie, no liveness
export const KYC_CAC_NGN = 550;
export const KYC_CAC_ADVANCED_NGN = 1_200;
export const KYC_KYB_HOSTED_NGN = 1_000;

// ── Vendors Hub (Phase 4) ──────────────────────────────────────────────
//
// Decided 2026-10-15: an Enterprise vendor pays NOTHING after the
// subscription except the boost push — advert pins are covered. Basic pays
// per pin and per send. The Basic pin price is confirmed; the pin window
// stays a PLACEHOLDER until Phase 0.5 closes it.
export const HUB_BROADCAST_COST_KOBO = 100_000; // ₦1,000 per send, BOTH tiers
export const HUB_ADVERT_COST_KOBO = 500_000; // ₦5,000 Basic pin
export const HUB_ADVERT_DAYS = 7; // PLACEHOLDER
/** Anti-abuse: live pins per vendor — free Enterprise pins would otherwise
 *  flood the hub top. Tunable. */
export const HUB_MAX_ACTIVE_ADVERTS_PER_VENDOR = 3;
/** Listing boost windows. Basic pays the naira price; Enterprise is free.
 *  Set from the vendor Boost page (2026-10-24). */
export const HUB_BOOST_TIERS = [
  { days: 3, costKobo: 200_000 },
  { days: 7, costKobo: 350_000 },
  { days: 14, costKobo: 600_000 },
];
/**
 * Placeholder estimated-reach ranges by boost window / price, until Hub
 * impression tracking exists. Absolute counts (not % of the buyer pool) so
 * a thin signup base still shows a useful range on the Boost page.
 * 3d ₦2,000 → 7d ₦3,500 → 14d ₦6,000.
 */
export const HUB_BOOST_REACH_PLACEHOLDER = {
  3: { min: 800, max: 1_600 },
  7: { min: 1_800, max: 3_500 },
  14: { min: 3_500, max: 7_000 },
};
/** AI advert poster generations per rolling allowance. After the last slot
 *  is used, the vendor waits 24h from that moment before the count resets. */
export const HUB_AI_POSTER_DAILY_BASIC = 2;
export const HUB_AI_POSTER_DAILY_ENTERPRISE = 5;
export const HUB_AI_POSTER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Sends per vendor per rolling 24h — Basic 1, Enterprise 5 (decided). */
export const HUB_BROADCAST_CAP_BASIC_PER_24H = 1;
export const HUB_BROADCAST_CAP_ENTERPRISE_PER_24H = 5;
/** Buyer Basic Hub preview caps. Premium and vendors see the full feed.
 *  Browse stays open; these only truncate how much is returned. */
export const HUB_BASIC_BUYER_VENDOR_CAP = 6;
export const HUB_BASIC_BUYER_LISTING_CAP = 8;
/** Median accept-to-delivered hours for the Fast delivery tag.
 *  Unset on purpose: the plan names the rule and not the cutoff, so the
 *  badge stays off until this is a number. */
export const FAST_DELIVERY_MAX_HOURS = null;
/** What a Premium buyer earns for placing a vendor advert. Unset: the
 *  placement is recorded and labelled, and no naira figure is shown. */
export const BUYER_ADVERT_COMMISSION_KOBO = null;
