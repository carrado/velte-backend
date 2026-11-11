// Who may do what (Phase 0.1 of docs/velte-platform-plan.md in the velte repo).
//
// ONE table, read by everything that gates a capability. Mirrored in the
// velte frontend's src/lib/entitlements.ts — keep the two in step: this copy
// is the one that is enforced, that one only decides what the UI offers.
//
// A tier is resolved per request by services/tier.service.js from the
// actor's account type and their Subscription (if any). Paid tiers don't
// have a checkout yet (Phase 2, prices unconfirmed), so in practice every
// buyer resolves to buyer_basic and every vendor to vendor_basic until a
// Subscription row exists for them.
//
// Being entitled to something is not the same as it being free. Most
// capabilities here still spend credits; this table only says whether the
// tier may attempt the action at all.

export const TIERS = [
  "guest",
  "buyer_basic",
  "buyer_premium",
  "vendor_basic",
  "vendor_enterprise",
];

const ALL = TIERS;
const SIGNED_IN = ["buyer_basic", "buyer_premium", "vendor_basic", "vendor_enterprise"];
const BUYERS = ["buyer_basic", "buyer_premium"];
const VENDORS = ["vendor_basic", "vendor_enterprise"];

export const CAPABILITIES = {
  // Discovery
  search: ALL,
  photo_search: ALL,
  compare: ALL,
  shopping_plan: SIGNED_IN,
  referrals: SIGNED_IN,
  top_up: SIGNED_IN,

  // Commerce
  cart_checkout: BUYERS,

  // Requests (Q10): Premium buyers and Enterprise vendors only.
  create_request: ["buyer_premium", "vendor_enterprise"],

  // Buyer Premium
  switch_to_vendor: ["buyer_premium"],
  onboard_vendors: ["buyer_premium"],
  validate_vendor: ["buyer_premium"],
  // Order-backed reviews — any signed-up buyer who completed the order.
  review_vendor: BUYERS,
  review_product: BUYERS,
  gigs: ["buyer_premium"],

  // Vendors
  list_products: VENDORS,
  receive_requests: VENDORS,

  // Q6: Enterprise vendors don't pay the per-lead fee.
  lead_fee_exempt: ["vendor_enterprise"],

  // Vendors Hub. Signed-up buyers and vendors. A guest has to create an
  // account first. Publish and social contact stay on their own capabilities.
  hub_discover: SIGNED_IN,
  place_advert: VENDORS,
  boost_advert: VENDORS,
  vendor_broadcast: VENDORS,
  analytics_insights: ["vendor_enterprise"],
  community_forum: ["buyer_premium", "vendor_enterprise"],
  // Buyer Premium + Vendor Enterprise. Basic buyers/vendors stay gated.
  hub_social_contact: ["buyer_premium", "vendor_enterprise"],
  buyer_place_advert: ["buyer_premium"],
  buyer_boost_advert: ["buyer_premium"],
  buyer_broadcast: ["buyer_premium"],
  favourite_vendor: ["buyer_premium"],
};

export function can(tier, capability) {
  const allowed = CAPABILITIES[capability];
  return Array.isArray(allowed) && allowed.includes(tier);
}

// ── Free allowances (Phase 0.3) ──────────────────────────────────────────
//
// Spent BEFORE the purchased balance and never carried over. Only these two
// tiers have one: a guest keeps the one-off browser allowance
// (GUEST_CREDITS on the frontend) and gets nothing daily (Q4), and vendors
// earn credits by listing instead.
//
// `daily` resets at midnight Lagos time. `window` is a rolling window that
// starts at the first spend after the previous one expired (Q5: "after a
// certain amount used, they wait ~5 hours and it resets").

export const DAILY_FREE_CREDITS = 20;

/** PLACEHOLDER — Q5 in the plan sets the 5-hour wait but not the size of the
 *  window. Confirm before Buyer Premium has a checkout. */
export const PREMIUM_WINDOW_CREDITS = 60;
export const PREMIUM_WINDOW_HOURS = 5;

export const ALLOWANCES = {
  buyer_basic: {
    kind: "daily",
    credits: DAILY_FREE_CREDITS,
    // Q4 (revised): a signed-up Buyer Basic. Guests are not Basic.
    // Phone verification stays the gate for buyer requests, not for this
    // allowance.
    requiresVerifiedPhone: false,
  },
  buyer_premium: {
    kind: "window",
    credits: PREMIUM_WINDOW_CREDITS,
    windowHours: PREMIUM_WINDOW_HOURS,
    requiresVerifiedPhone: false,
  },
};
