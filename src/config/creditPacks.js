// What a top-up buys (2026-08-31).
//
// MIRRORS the frontend's src/lib/creditPacks.ts, which is what the panel
// renders. The split is the same one plan prices had and for the same reason:
// the page shows these numbers, but the CHARGE is built here, from this file,
// so a client that lied about a price would be charging itself nothing.
//
// Keep the two in step. The frontend table is what a buyer is promised; this
// one is what they get.
export const CREDIT_PACKS = [
  { id: "starter", priceNgn: 500, credits: 50, bonus: 0 },
  { id: "regular", priceNgn: 1500, credits: 165, bonus: 15 },
  { id: "shopper", priceNgn: 3000, credits: 350, bonus: 50 },
  { id: "big", priceNgn: 5000, credits: 625, bonus: 125 },
];

/** Resolves a pack from an untrusted request body — by ID only. A price or a
 *  credit count arriving from a client is never read. */
export function packFor(id) {
  if (typeof id !== "string") return null;
  return CREDIT_PACKS.find((pack) => pack.id === id) ?? null;
}
