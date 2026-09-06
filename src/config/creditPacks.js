// What a top-up buys (2026-08-31, floor raised 2026-09-05, revised twice
// more the same day).
//
// MIRRORS the frontend's src/lib/creditPacks.ts, which is what the panel
// renders. The split is the same one plan prices had and for the same reason:
// the page shows these numbers, but the CHARGE is built here, from this file,
// so a client that lied about a price would be charging itself nothing.
//
// Keep the two in step. The frontend table is what a buyer is promised; this
// one is what they get. See that file's own header for the full revision
// history — settled at a direct ₦1,500/30-credit floor (₦50/credit), the
// three tiers above it designed at that same rate with the same
// bonus-percentage curve every version of this ladder has used.
export const CREDIT_PACKS = [
  { id: "starter", priceNgn: 1500, credits: 30, bonus: 0 },
  { id: "regular", priceNgn: 3000, credits: 66, bonus: 6 },
  { id: "shopper", priceNgn: 6000, credits: 140, bonus: 20 },
  { id: "big", priceNgn: 12000, credits: 300, bonus: 60 },
];

/** Resolves a pack from an untrusted request body — by ID only. A price or a
 *  credit count arriving from a client is never read. */
export function packFor(id) {
  if (typeof id !== "string") return null;
  return CREDIT_PACKS.find((pack) => pack.id === id) ?? null;
}
