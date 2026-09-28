// What a top-up buys — ONE rate, any amount (2026-09-28).
//
// MIRRORS the frontend's src/lib/creditPacks.ts, which is what the panel
// renders the live estimate from. The split is the same one plan prices had
// and for the same reason: the panel shows these numbers, but the CHARGE is
// built HERE, so a client that lied about an amount is still only naming a
// figure — the credits it buys are computed on this side.
//
// The four-pack ladder is gone (see the frontend file's own header). The rate
// is defined by its floor: ₦2,000 buys 30 credits, and every other amount is a
// straight multiple of that. Keep the two files in step; the frontend table is
// what a buyer is promised, this one is what they get.
export const MIN_TOPUP_NGN = 2000;
export const CREDITS_AT_MIN_TOPUP = 30;
export const CREDITS_PER_NAIRA = CREDITS_AT_MIN_TOPUP / MIN_TOPUP_NGN;
export const MAX_TOPUP_NGN = 500000;

/** The credits `amountNgn` buys, rounded to the nearest whole credit. 0 below
 *  the floor. Identical arithmetic to the frontend's creditsForAmount. */
export function creditsForAmount(amountNgn) {
  if (!Number.isFinite(amountNgn) || amountNgn < MIN_TOPUP_NGN) return 0;
  return Math.round(amountNgn * CREDITS_PER_NAIRA);
}

// The RETIRED four-pack ladder, kept ONLY so a Paystack transaction opened
// just before this shipped still credits correctly when its webhook lands
// after it — the same "leave a trap for the in-flight case" reasoning the
// subscription webhook uses for retired buyer plans. Nothing new reads it; a
// checkout opened by the current code carries no packId at all.
const RETIRED_CREDIT_PACKS = [
  { id: "starter", priceNgn: 1500, credits: 30, bonus: 0 },
  { id: "regular", priceNgn: 3000, credits: 66, bonus: 6 },
  { id: "shopper", priceNgn: 6000, credits: 140, bonus: 20 },
  { id: "big", priceNgn: 12000, credits: 300, bonus: 60 },
];

/** Resolves a RETIRED pack from an in-flight transaction's metadata, by ID
 *  only. Never read for a new checkout. */
export function packFor(id) {
  if (typeof id !== "string") return null;
  return RETIRED_CREDIT_PACKS.find((pack) => pack.id === id) ?? null;
}
