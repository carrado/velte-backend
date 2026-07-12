// Retrieval core (Velte_Connect_Technical_Implementation.md §6) — embeds
// products/stores on save and ranks buyer queries by
// semanticRelevance + proximity + vendorTrust. `placementBoost` is left out:
// monetization isn't switched on yet (§11's own sequencing note).
//
// This is the reusable seam that /api/search's searchProducts/searchStores
// tools call directly.

import Product from "../models/Product.model.js";
import Store from "../models/Store.model.js";
import User from "../models/Users.js";
import Wallet from "../models/Wallet.model.js";
import Notification from "../models/Notification.model.js";
import { embed, embedImage, rerank } from "./voyage.service.js";
import { reverseGeocodeState } from "./nominatim.service.js";
import { searchNearbyBusinesses } from "./googlePlaces.service.js";
import { notifyUser } from "./pushNotification.service.js";
import {
  getOrCreateWallet,
  LEAD_COST_KOBO,
} from "../controllers/wallet/wallet.controller.js";

const VECTOR_INDEX_NAME = "product_vector_index";
const STORE_VECTOR_INDEX_NAME = "store_vector_index";

const WEIGHTS = {
  semantic: 0.5,
  proximity: 0.3,
  trust: 0.2,
};

// Used when there's no location signal at all — device permission denied/
// unavailable AND the buyer named no place in their query. There's nothing
// to score proximity against, so that term is dropped entirely and
// semantic/trust are renormalized proportionally (0.5:0.2 becomes
// ~0.714:0.286) rather than inventing a new, uncalibrated ratio.
const NATIONWIDE_WEIGHTS = {
  semantic: WEIGHTS.semantic / (WEIGHTS.semantic + WEIGHTS.trust),
  trust: WEIGHTS.trust / (WEIGHTS.semantic + WEIGHTS.trust),
};

// Tier 2 ("nearby") radius, as a multiplier of the caller's own tight-radius
// (Tier 1) value rather than a fixed km number — so a tool call that
// widened Tier 1 gets a proportionally wider Tier 2 too. Meant to still
// read as "your city/area," just less strict than Tier 1, before giving up
// on distance altogether and going state-wide.
const NEARBY_RADIUS_MULTIPLIER = 3;

// A state-wide fallback match has no radiusKm to bound distance by (could
// legitimately be 100s of km within one large state) — this is the
// reference distance proximity is normalized against instead, just so
// closer-within-state still outranks farther-within-state.
const STATE_PROXIMITY_REFERENCE_KM = 300;

// Minimum semantic score a candidate needs to count as a real match —
// without this, an irrelevant query ("car engine") still returned the
// entire nearby catalog, just weakly ranked, since geo + trust alone can't
// tell a genuine match from a merely-nearby product.
//
// Two separate constants, not one shared threshold: rerank scores (a
// calibrated relevance probability) and raw Atlas vectorSearchScore (cosine
// similarity rescaled to 0-1, per Atlas's own formula) are different
// distributions. Raw cosine similarity within one narrow product-catalog
// embedding space runs high even for unrelated items, so a floor tuned
// against reranked scores would likely be too permissive applied to raw
// scores directly.
//
// RERANK_FLOOR is session-validated: two independent live "white sneakers"
// runs (different proximity, different providers extracting the query
// text) both landed genuine matches at ~0.60-0.84 and the one "car engine"
// non-match run at ~0.53-0.58 — a real but narrow gap, still only tested
// against one non-match query. RAW_SCORE_FLOOR has never actually been
// exercised live (Voyage's rerank has succeeded in every test so far) —
// it's a reasoned placeholder (set higher, since raw cosine similarity is
// less discriminative), not a validated one. Revisit both with a larger,
// more varied catalog.
const RERANK_FLOOR = 0.58;
const RAW_SCORE_FLOOR = 0.75;

// Shared time budget for every Voyage call (embed + embedImage + however
// many geo tiers' rerank calls) within ONE searchProducts or searchStores
// invocation. Without this, each call gets its own full retry budget
// independently, and a search that legitimately needs several calls (a photo
// query cascading through local→nearby→state tiers) could compound toward
// several minutes worst-case — far past any serverless function's duration
// ceiling. 22s leaves headroom under Vercel's default Pro-plan duration once
// `maxDuration` is set explicitly on the route, while still allowing a
// couple of real attempts per call rather than a single be-lucky-or-fail
// shot. Passed straight through to voyage.service.js's exported functions,
// which cap both their per-attempt timeout and retry eligibility against it.
const SEARCH_DEADLINE_MS = 22_000;

// Separate floor for store-level search — store embedding text is typically
// much sparser than product text, so reusing the product floor values isn't
// justified without checking.
//
// STORE_RAW_SCORE_FLOOR is now session-validated against one real filled-out
// store profile (description + sectors): the genuine match "fashion vendor"
// scored 0.7474 raw, while clear non-matches "car engine parts" (0.5858) and
// "electronics repair shop" (0.6525) scored well below it. 0.70 sits almost
// exactly centered in that gap (~0.047 margin on each side). The prior 0.75
// placeholder was rejecting this real match by a hair (0.0026) whenever
// Voyage's rerank was unavailable (e.g. rate-limited) and raw score was the
// only signal left. Revisit with a larger, more varied store catalog.
const STORE_RERANK_FLOOR = 0.58;
const STORE_RAW_SCORE_FLOOR = 0.7;

// How much above the base relevance floor a candidate must score to count
// as a "direct" match rather than merely "similar" — only used for
// image-derived product searches (searchProducts({isImageQuery: true})).
// Expressed as a margin above whichever floor actually applied (rerank or
// raw-score), not an absolute number, since the two floors sit on different
// scales (documented above).
//
// Recalibrated down from an initial 0.15: a live cosine-similarity check
// comparing each of two catalog handbags' image against ITSELF scored
// 0.94-0.96, while against the OTHER handbag it scored only 0.51-0.56 — a
// huge, easily-separable gap, but that self-comparison is the best case. A
// buyer's real photo of the same physical item, taken at a different angle/
// lighting/phone, will score meaningfully lower than 0.94-0.96 against the
// catalog photo even for a genuine match — found live as a real exact match
// landing in "similar" instead of "direct." 0.15 was calibrated blind to
// that self-vs-real-photo gap; 0.08 leaves room for a real (non-identical)
// matching photo to still clear the bar while the ~0.4 self/cross gap above
// means a genuinely different item still shouldn't reach it. Still a
// reasoned estimate, not measured against an actual "second photo of the
// same item" — revisit once there's real buyer photo-search volume to
// calibrate against.
const IMAGE_MATCH_MARGIN = 0.08;

// How much a product's own visual similarity (voyage-multimodal-3 cosine
// score against the query photo) counts versus its text-derived semantic
// score, for image-derived searches only.
//
// Raised from an initial 0.5: the same live check above showed visual
// similarity is far more discriminative for this catalog than text — two
// different handbags read almost identically in text (both "leather
// handbag"-style descriptions) but ~0.4 apart visually. Leaning more on the
// more discriminative signal, rather than splitting evenly, lets a strong
// visual match outweigh a middling text description. Safe to raise without
// reintroducing the earlier "blended score fell below floor" regression:
// eligibility is gated on textScore alone (see rankCandidates below), this
// weight only affects ranking/matchQuality among already-eligible
// candidates. Only applied when both the query photo and the candidate
// product actually have an image embedding — products saved before this
// feature existed still match on text alone until re-saved or backfilled.
const VISUAL_BLEND_WEIGHT = 0.65;

// Eligibility escape hatch for image-derived searches only: a candidate whose
// own photo is THIS visually similar to the buyer's photo counts as a match
// even if it fails the normal text floor. Found live: a buyer's photo of an
// item already in the catalog — literally the identical photo, in one test —
// still missed the text floor on some runs, because the model's own visually
// accurate description (e.g. reading a brand tag or fabric detail off the
// photo) doesn't always appear in the seller's own listing text, and Voyage's
// rerank scores that as a partial mismatch rather than a bonus. Visual
// similarity has no such failure mode — it doesn't care what words either
// side used. 0.82 sits well below the ~0.95 a photo scores against ITSELF
// (leaving room for a real buyer photo — different angle/lighting/phone —
// to still clear it) and well above the ~0.51 two different catalog items
// scored against each other (live-measured, both cited in IMAGE_MATCH_MARGIN's
// own comment above). Still a reasoned estimate pending real buyer-photo
// volume to calibrate against, same as every other floor in this file.
const VISUAL_ELIGIBILITY_FLOOR = 0.82;

/** Cosine similarity between two equal-length embedding vectors. */
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function productEmbeddingText(product) {
  const attrs = (product.attributes || [])
    .map((a) => `${a.name}: ${a.value}`)
    .join(", ");
  return [product.name, product.categoryId, attrs, product.description]
    .filter(Boolean)
    .join(". ");
}

function storeEmbeddingText(store) {
  return [store.name, (store.sectors || []).join(" "), store.description]
    .filter(Boolean)
    .join(". ");
}

/**
 * Embed a product's text and (if it has one) its main image, and persist
 * both vectors. Best-effort — never throws; the two embeddings fail
 * independently so a Voyage multimodal outage doesn't also block the text
 * embedding that already worked fine.
 */
export async function embedAndSaveProduct(product) {
  const $set = {};

  try {
    const vectors = await embed([productEmbeddingText(product)], "document");
    if (vectors?.[0]) $set.embedding = vectors[0];
  } catch (err) {
    console.error("[retrieval] embedAndSaveProduct text embed failed:", err.message);
  }

  if (product.mainImageUrl) {
    try {
      // Pure image, no accompanying text — must match the query side's
      // embedImage(imageUrl, "query") call (also pure image) in
      // searchProducts below. Pairing text with only one side skews that
      // one embedding toward text-embedding-space, making cosine similarity
      // against the other, purely-visual side systematically lower even for
      // a genuine visual match (found live: this alone was enough to sink a
      // real match's blended score under the relevance floor).
      const imageVector = await embedImage(product.mainImageUrl, "document");
      if (imageVector) $set.imageEmbedding = imageVector;
    } catch (err) {
      console.error("[retrieval] embedAndSaveProduct image embed failed:", err.message);
    }
  }

  if (Object.keys($set).length === 0) return;
  try {
    await Product.updateOne({ _id: product._id }, { $set });
  } catch (err) {
    console.error("[retrieval] embedAndSaveProduct save failed:", err.message);
  }
}

/** Embed a store and persist the vector. Best-effort — never throws. */
export async function embedAndSaveStore(store) {
  try {
    const vectors = await embed([storeEmbeddingText(store)], "document");
    if (!vectors?.[0]) return;
    await Store.updateOne(
      { _id: store._id },
      { $set: { embedding: vectors[0] } },
    );
  } catch (err) {
    console.error("[retrieval] embedAndSaveStore failed:", err.message);
  }
}

/** Great-circle distance in km between two [lng, lat] points. */
function haversineKm([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Shared Tier 5 for both searchProducts and searchStores once every
 * Velte-vendor geo tier has come up empty (or been fully wallet-filtered
 * out) — real nearby businesses via Google Places, fed the raw buyer query
 * text either way (a product name matches a store's Places listing about as
 * well as a business-type description does). Clearly a different kind of
 * result from a real Velte match: no trust score, no WhatsApp, no Velte
 * relationship. Best-effort — null on any failure or nothing within radius.
 */
async function googlePlacesFallback(queryText, lat, lng, radiusKm) {
  const places = await searchNearbyBusinesses({ queryText, lat, lng, radiusKm });
  // Google's locationBias is a soft hint, not a hard radius filter — a
  // strong text match can still outrank nothing at all even if it's in a
  // different city or state entirely (found live: a buyer in Enugu got a
  // business actually in Anambra). Enforce radiusKm ourselves, same as
  // every Velte-vendor tier above already does, rather than trusting
  // Google's ranking to respect proximity on its own.
  const externalSuggestions = places
    ?.map((p) => ({
      placeId: p.placeId,
      name: p.name,
      address: p.address,
      lat: p.lat,
      lng: p.lng,
      distanceKm: Math.round(haversineKm([lng, lat], [p.lng, p.lat]) * 10) / 10,
    }))
    .filter((p) => p.distanceKm <= radiusKm);

  return externalSuggestions?.length ? externalSuggestions : null;
}

/**
 * Drops any candidate whose vendor can't cover one more lead (see
 * LEAD_COST_KOBO) — a vendor's search visibility is gated on actually being
 * able to pay for the WhatsApp click a match generates, not just on
 * matching well. Runs against the full ranked list BEFORE the caller slices
 * to `limit`, so a tier still surfaces up to `limit` genuinely-payable
 * vendors when more than `limit` existed pre-filter, and correctly falls
 * through to the next geo tier (and eventually Tier 5's Google Places
 * fallback in searchStores) when filtering empties a tier out entirely.
 *
 * Batches one query for vendors that already have a wallet; only the rare
 * vendor with none yet pays the extra per-vendor round trip to
 * getOrCreateWallet — which auto-grants the starter credit right then, so a
 * brand-new vendor is immediately eligible rather than silently invisible
 * in search until they happen to open the wallet page first.
 */
async function filterWalletEligible(rankedCandidates) {
  if (!rankedCandidates.length) return rankedCandidates;

  const vendorIds = [...new Set(rankedCandidates.map((c) => String(c.vendor._id)))];
  const existingWallets = await Wallet.find({ vendorId: { $in: vendorIds } }).select(
    "vendorId balanceKobo",
  );
  const balanceById = new Map(
    existingWallets.map((w) => [String(w.vendorId), w.balanceKobo]),
  );

  const missingIds = vendorIds.filter((id) => !balanceById.has(id));
  if (missingIds.length) {
    const created = await Promise.all(missingIds.map((id) => getOrCreateWallet(id)));
    created.forEach((w) => balanceById.set(String(w.vendorId), w.balanceKobo));
  }

  return rankedCandidates.filter(
    (c) => (balanceById.get(String(c.vendor._id)) ?? 0) >= LEAD_COST_KOBO,
  );
}

function isExpiredProduct(product) {
  return Boolean(product.expirationDate) && product.expirationDate.getTime() < Date.now();
}

// A popular expired listing could otherwise get searched dozens of times a
// day and fire a notification on every single one — this caps it to once
// per vendor per product within the window, same "once per episode" idea as
// walletLowBalance.job.js's lowBalanceNotified flag, just query-based here
// since there's no per-product boolean field to flip.
const EXPIRED_MATCH_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort, fire-and-forget: tells a vendor a buyer just searched for
 * something that matched one of their listings, except the listing is
 * expired and so was held back from the buyer's results (see splitExpired
 * below). Never awaited by callers — notifying is not on the buyer's
 * critical path, same pattern as chargeLead's own notifyUser call.
 */
async function notifyExpiredMatches(expiredCandidates, queryText) {
  await Promise.allSettled(
    expiredCandidates.map(async ({ product, vendor }) => {
      try {
        const tag = `expired-product-${product._id}`;
        const recent = await Notification.findOne({
          userId: vendor._id,
          tag,
          createdAt: { $gte: new Date(Date.now() - EXPIRED_MATCH_NOTIFY_COOLDOWN_MS) },
        }).select("_id");
        if (recent) return;

        await notifyUser(vendor._id, {
          type: "expired-product",
          title: "Buyers are searching for an expired listing",
          body: `"${product.name}" matched a buyer's search for "${queryText}" but is hidden from results because it's expired. Update its expiration date or remove it so it can be found again.`,
          url: `/${vendor._id}/products/${product._id}/edit`,
          tag,
        });
      } catch (err) {
        console.error(
          `[retrieval] expired-product notify failed for vendor ${vendor._id}, product ${product._id}:`,
          err.message,
        );
      }
    }),
  );
}

/**
 * Splits a tier's already-ranked candidates into active vs. expired.
 * Deliberately runs AFTER rerank/floor/wallet-eligibility (rankCandidates +
 * applyMatchQuality already happened) — only a candidate that already
 * cleared the exact same bar a real result does gets flagged here, so a
 * vendor is never notified over a merely embeddings-similar, not-actually-
 * relevant candidate. Expired candidates are fully removed from what the
 * buyer sees; a fire-and-forget notification goes out to each one's vendor
 * instead (never awaited — see notifyExpiredMatches).
 */
function splitExpired(tierCandidates, queryText) {
  const expired = tierCandidates.filter((c) => isExpiredProduct(c.product));
  const active = tierCandidates.filter((c) => !isExpiredProduct(c.product));
  if (expired.length) {
    notifyExpiredMatches(expired, queryText).catch((err) =>
      console.error("[retrieval] notifyExpiredMatches failed:", err.message),
    );
  }
  return active;
}

/**
 * Shared core for both searchProducts and searchStores: join vendors, apply
 * a geo filter (different per tier), rerank/floor, and rank by
 * semantic + proximity + trust. `entityKey` is "product" or "store" — the
 * caller does its own entity-specific field mapping afterward, since
 * VendorMatch/StoreMatch have different shapes.
 *
 * `lat`/`lng` (and therefore `geoFilter`/`proximityReferenceKm`) are
 * optional: when omitted, this runs in "locationless" mode — no vendor.geo
 * requirement, no distance/proximity term at all, `weights` should be
 * NATIONWIDE_WEIGHTS (semantic + trust only) rather than the default.
 */
async function rankCandidates({
  candidates,
  vendorById,
  entityKey,
  embeddingTextFn,
  queryText,
  lat,
  lng,
  geoFilter,
  proximityReferenceKm,
  rerankFloor,
  rawScoreFloor,
  limit,
  // Only ever passed for searchProducts' image-derived searches — a query
  // photo's own voyage-multimodal-3 embedding. Blended into semanticScore
  // for any candidate that also has one (see VISUAL_BLEND_WEIGHT above).
  queryImageVector,
  weights = WEIGHTS,
  // Shared across every Voyage call within one searchProducts/searchStores
  // invocation — see SEARCH_DEADLINE_MS above.
  deadlineAt,
}) {
  const locationless = lat == null || lng == null;

  const withVendor = candidates
    .map((entity) => {
      const vendor = vendorById.get(String(entity.vendorId));
      if (!vendor) return null;
      if (locationless) {
        return { [entityKey]: entity, vendor, distanceKm: null };
      }
      if (!vendor.geo?.coordinates?.length) return null;
      const distanceKm = haversineKm([lng, lat], vendor.geo.coordinates);
      if (!geoFilter(vendor, distanceKm)) return null;
      return { [entityKey]: entity, vendor, distanceKm };
    })
    .filter(Boolean);
  if (!withVendor.length) return { candidates: [], relevanceFloor: null };

  // Optional precision pass — silently falls back to vector-search score if
  // Voyage's rerank endpoint is unavailable.
  const rerankScores = await rerank(
    queryText,
    withVendor.map((c) => embeddingTextFn(c[entityKey])),
    deadlineAt,
  );
  const relevanceFloor = rerankScores ? rerankFloor : rawScoreFloor;

  const ranked = withVendor
    .map((c, i) => ({
      ...c,
      textScore: rerankScores ? rerankScores[i] : c[entityKey].score,
    }))
    // Computed once, up front — reused both for the eligibility check right
    // below AND the ranking blend further down, rather than recomputing.
    .map((c) => {
      const imageEmbedding = c[entityKey].imageEmbedding;
      const visualScore =
        queryImageVector && imageEmbedding
          ? cosineSimilarity(queryImageVector, imageEmbedding)
          : null;
      return { ...c, visualScore };
    })
    // Eligibility is gated on textScore alone by default — a genuine match
    // that already cleared the floor on text must never be knocked back out
    // by a merely-average visual score (found live: a real catalog match
    // stopped surfacing entirely once a weak cosine similarity dragged its
    // blended score under the floor). The OR here is a narrow, deliberate
    // exception, not a loophole: only a visual score far above what two
    // genuinely different catalog items ever scored against each other can
    // grant eligibility on its own (see VISUAL_ELIGIBILITY_FLOOR above) —
    // this never lowers the bar for a text-only search, since visualScore is
    // null whenever there's no query photo at all.
    .filter(
      (c) =>
        c.textScore >= relevanceFloor ||
        (c.visualScore != null && c.visualScore >= VISUAL_ELIGIBILITY_FLOOR),
    )
    .map((c) => {
      const semanticScore =
        c.visualScore != null
          ? VISUAL_BLEND_WEIGHT * c.visualScore + (1 - VISUAL_BLEND_WEIGHT) * c.textScore
          : c.textScore;
      return { ...c, semanticScore };
    })
    .map((c) => {
      const trustComponent = (c.vendor.trustScore ?? 0) / 100;
      if (locationless) {
        const score = weights.semantic * c.semanticScore + weights.trust * trustComponent;
        return { ...c, score };
      }
      const proximityScore = Math.max(0, 1 - c.distanceKm / proximityReferenceKm);
      const score =
        weights.semantic * c.semanticScore +
        weights.proximity * proximityScore +
        weights.trust * trustComponent;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  const eligible = await filterWalletEligible(ranked);

  return { candidates: eligible.slice(0, limit), relevanceFloor };
}

// Splits a tier's already-ranked candidates into "direct" (clears floor +
// IMAGE_MATCH_MARGIN) vs "similar" (everything else that still cleared the
// base floor). A non-empty direct set wins outright — the merely-similar
// candidates are dropped, not just re-ranked lower, per the same "don't show
// a weak match with no way to say so" reasoning rankCandidates already
// applies to the base floor. `tieredQuery` is true for image-derived
// searches only. Plain text queries (tieredQuery false) pass through
// unchanged.
function applyMatchQuality(tierCandidates, relevanceFloor, tieredQuery) {
  if (!tieredQuery || !tierCandidates.length) {
    return { candidates: tierCandidates, matchQuality: undefined };
  }
  const directFloor = relevanceFloor + IMAGE_MATCH_MARGIN;
  const direct = tierCandidates.filter((c) => c.semanticScore >= directFloor);
  return direct.length
    ? { candidates: direct, matchQuality: "direct" }
    : { candidates: tierCandidates, matchQuality: "similar" };
}

/**
 * Search products by meaning + proximity + trust. `lat`/`lng` are optional —
 * omit both for a "nationwide" search (no location signal at all: device
 * permission denied/unavailable AND the buyer named no place). When a
 * location IS known, geo tiers cascade before giving up: a tight radius
 * ("local"), a wider same-city radius ("nearby") only if Tier 1 is empty,
 * then the buyer's whole state ("state") only if Tier 2 is also empty, then
 * a state-agnostic nationwide pass ("nationwide") only if Tier 3 is also
 * empty — a real vendor just across a state border (e.g. buyer in Enugu,
 * vendor in Anambra) is otherwise invisible forever, since Tier 3's state
 * match is an exact string comparison with no distance-based bridge between
 * "same state" and nothing. Later tiers don't re-run the vector search, just
 * re-filter/re-rank the same top candidates. Throws only if the query itself
 * can't be embedded (Voyage down / no key) — that's a hard stop, not a
 * degrade, since there's nothing to search without a query vector.
 *
 * Plus a Tier 5, same as searchStores, only reachable when a location IS
 * known and Tiers 1-4 are all empty: real nearby businesses via Google
 * Places, fed the raw product query text since there's no confirmed
 * business type the way searchStores already has one.
 */
export async function searchProducts({
  queryText,
  lat,
  lng,
  radiusKm = 10,
  limit = 20,
  isImageQuery = false,
  // The buyer's actual photo URL (Cloudinary) — not the LLM's text
  // description of it. Only meaningful when isImageQuery is true. Best-
  // effort: a failed/unavailable multimodal embed just falls back to
  // today's text-only matching rather than failing the whole search.
  imageUrl,
}) {
  // Shared across every Voyage call this invocation makes (below, and every
  // rerank inside rankCandidates as tiers cascade) — see SEARCH_DEADLINE_MS.
  const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;

  const tieredQuery = isImageQuery;

  const queryVectors = await embed([queryText], "query", deadlineAt);
  const queryVector = queryVectors?.[0];
  if (!queryVector) {
    throw new Error("Could not embed the search query (Voyage unavailable).");
  }

  const queryImageVector =
    isImageQuery && imageUrl
      ? await embedImage(imageUrl, "query", undefined, deadlineAt)
      : null;

  const candidates = await Product.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector,
        numCandidates: 150,
        limit: 50,
      },
    },
    {
      $project: {
        embedding: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]);
  if (!candidates.length) {
    return { results: [], matchTier: null, matchQuality: undefined, externalSuggestions: null };
  }

  const vendorIds = [...new Set(candidates.map((c) => String(c.vendorId)))];
  const [vendors, stores] = await Promise.all([
    User.find({ _id: { $in: vendorIds } }).select(
      "geo trustScore area state name phone company avatar",
    ),
    // The marketplace's actual unit of identity is the Store, not the
    // person who owns it — a product card showing "Chukwuemeka Anyanwu"
    // instead of "Acme Stores Limited" was a real bug found live. Batched
    // alongside the vendor fetch so this costs one extra indexed query, not
    // a second round trip per product.
    Store.find({ vendorId: { $in: vendorIds } }).select("vendorId name whatsapp"),
  ]);
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));
  const storeByVendorId = new Map(
    stores.map((s) => [String(s.vendorId), s]),
  );

  const mapResult = ({ product, vendor, distanceKm, score }) => {
    const store = storeByVendorId.get(String(vendor._id));
    return {
      productId: product._id,
      kind: product.kind === "service" ? "service" : "product",
      name: product.name,
      // Product.price/priceMax are stored in kobo (AddProductPage.tsx sends
      // Math.round(price * 100)) — convert to the real Naira amount here so
      // neither the LLM nor any UI ever quotes a 100x-inflated price.
      price: product.price / 100,
      priceMax: product.priceMax != null ? product.priceMax / 100 : null,
      // Quote-per-job service: price is stored as 0 but is NOT a real price —
      // consumers must show "ask for price"/"quoted per job", never ₦0.
      quoteOnRequest: product.quoteOnRequest === true,
      currency: product.currency,
      mainImageUrl: product.mainImageUrl,
      description: product.description ?? null,
      // Everything the vendor uploaded for this listing — shown in full on a
      // service result's own card instead of a separate vendor/store card
      // (see VendorResultCard.tsx on the frontend).
      attributes: (product.attributes || []).map((a) => ({
        name: a.name,
        value: a.value,
      })),
      vendorId: vendor._id,
      // Store.name (edited via store settings) is the real business
      // identity; company.name (set once at onboarding) is the next-best
      // fallback if a Store doc somehow doesn't exist yet; vendor.name (the
      // person's own name) is the last resort, not the norm.
      vendorName: store?.name || vendor.company?.name || vendor.name,
      area: vendor.area,
      state: vendor.state,
      // Same precedence as the name above: Store.whatsapp is the number a
      // vendor can update any time from their store settings, so it's more
      // likely current than vendor.phone (captured once at onboarding and
      // never revisited — "This should be your WhatsApp Business number" in
      // Step1BusinessAccount.tsx). Either can be the only one actually set.
      whatsapp: store?.whatsapp || vendor.phone || null,
      // null in nationwide mode — there's no buyer coordinate to measure
      // against, so the frontend must not render a distance at all.
      distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
      score: Math.round(score * 1000) / 1000,
    };
  };

  const rankArgs = {
    candidates,
    vendorById,
    entityKey: "product",
    embeddingTextFn: productEmbeddingText,
    queryText,
    rerankFloor: RERANK_FLOOR,
    rawScoreFloor: RAW_SCORE_FLOOR,
    limit,
    queryImageVector,
    deadlineAt,
  };

  const hasLocation = typeof lat === "number" && typeof lng === "number";

  if (!hasLocation) {
    const { candidates: nationwide, relevanceFloor } = await rankCandidates({
      ...rankArgs,
      weights: NATIONWIDE_WEIGHTS,
    });
    if (!nationwide.length) {
      // No Tier 5 here, same as searchStores — a "nearby business" fallback
      // is meaningless without somewhere to be near.
      return { results: [], matchTier: null, matchQuality: undefined, externalSuggestions: null };
    }
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      nationwide,
      relevanceFloor,
      tieredQuery,
    );
    // No further tier to fall through to here (see the "No Tier 5" note
    // above) — an all-expired tier just reads as "nothing found", same
    // shape as the !nationwide.length branch above.
    const active = splitExpired(tiered, queryText);
    return {
      results: active.map(mapResult),
      matchTier: active.length ? "nationwide" : null,
      matchQuality: active.length ? matchQuality : undefined,
      externalSuggestions: null,
    };
  }

  const locatedArgs = { ...rankArgs, lat, lng };

  // Tier 1: tight radius.
  const { candidates: local, relevanceFloor: localFloor } = await rankCandidates({
    ...locatedArgs,
    geoFilter: (_vendor, distanceKm) => distanceKm <= radiusKm,
    proximityReferenceKm: radiusKm,
  });
  if (local.length) {
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      local,
      localFloor,
      tieredQuery,
    );
    // Expired candidates are pulled out (and their vendors notified) before
    // this counts as a real match — if that was ALL this tier had, fall
    // through to Tier 2 below same as if local had come back empty.
    const active = splitExpired(tiered, queryText);
    if (active.length) {
      return {
        results: active.map(mapResult),
        matchTier: "local",
        matchQuality,
        externalSuggestions: null,
      };
    }
  }

  // Tier 2: "nearby" — wider than Tier 1 but still a local search, tried
  // before giving up on distance altogether and going state-wide.
  const nearbyRadiusKm = radiusKm * NEARBY_RADIUS_MULTIPLIER;
  const { candidates: nearby, relevanceFloor: nearbyFloor } = await rankCandidates({
    ...locatedArgs,
    geoFilter: (_vendor, distanceKm) => distanceKm <= nearbyRadiusKm,
    proximityReferenceKm: nearbyRadiusKm,
  });
  if (nearby.length) {
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      nearby,
      nearbyFloor,
      tieredQuery,
    );
    // Same expired-fallthrough handling as Tier 1 above.
    const active = splitExpired(tiered, queryText);
    if (active.length) {
      return {
        results: active.map(mapResult),
        matchTier: "nearby",
        matchQuality,
        externalSuggestions: null,
      };
    }
  }

  // Tier 3: same state — reachable even when reverseGeocodeState fails,
  // since the tiers below (nationwide, then Google Places) don't need a
  // state name, just coordinates (same as searchStores).
  const buyerState = await reverseGeocodeState(lat, lng);
  const { candidates: stateWide, relevanceFloor: stateFloor } = buyerState
    ? await rankCandidates({
        ...locatedArgs,
        geoFilter: (vendor) =>
          Boolean(vendor.state) &&
          vendor.state.toLowerCase() === buyerState.toLowerCase(),
        proximityReferenceKm: STATE_PROXIMITY_REFERENCE_KM,
      })
    : { candidates: [], relevanceFloor: null };

  if (stateWide.length) {
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      stateWide,
      stateFloor,
      tieredQuery,
    );
    // Same expired-fallthrough handling as Tiers 1-2 above.
    const active = splitExpired(tiered, queryText);
    if (active.length) {
      return {
        results: active.map(mapResult),
        matchTier: "state",
        matchQuality,
        externalSuggestions: null,
      };
    }
  }

  // Tier 4: nationwide, state-agnostic — a real vendor just across the
  // buyer's state border (or anywhere else in the country) shouldn't lose to
  // an external, non-Velte Google Places result just because Tier 3's state
  // match is an exact boundary with no distance bridge. Same semantic+trust-
  // only ranking as the no-location branch above (rankArgs has no lat/lng,
  // so rankCandidates runs in locationless mode — distanceKm comes back
  // null, same as a genuinely nationwide search).
  const { candidates: nationwide, relevanceFloor: nationwideFloor } =
    await rankCandidates({ ...rankArgs, weights: NATIONWIDE_WEIGHTS });
  if (nationwide.length) {
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      nationwide,
      nationwideFloor,
      tieredQuery,
    );
    // Same expired-fallthrough handling as Tiers 1-3 above — an all-expired
    // Tier 4 falls through to Tier 5's Google Places fallback below, same as
    // if nationwide had come back genuinely empty.
    const active = splitExpired(tiered, queryText);
    if (active.length) {
      return {
        results: active.map(mapResult),
        matchTier: "nationwide",
        matchQuality,
        externalSuggestions: null,
      };
    }
  }

  // Tier 5: no Velte vendor matched at all.
  const externalSuggestions = await googlePlacesFallback(queryText, lat, lng, radiusKm);
  return {
    results: [],
    matchTier: null,
    matchQuality: undefined,
    externalSuggestions,
  };
}

/**
 * Search stores (vendors as a business) by meaning + proximity + trust —
 * for a buyer describing a *kind* of business/vendor/shop rather than a
 * specific item. Same tiering as searchProducts (nationwide when no
 * location, then local → nearby → state → state-agnostic nationwide when
 * one is known), plus a Tier 5 only reachable when a location IS known:
 * real nearby businesses via Google Places, since a "nearby business" search
 * is meaningless without somewhere to be near.
 */
export async function searchStores({
  queryText,
  lat,
  lng,
  radiusKm = 10,
  limit = 20,
}) {
  // Shared across every Voyage call this invocation makes — see
  // SEARCH_DEADLINE_MS.
  const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;

  const queryVectors = await embed([queryText], "query", deadlineAt);
  const queryVector = queryVectors?.[0];
  if (!queryVector) {
    throw new Error("Could not embed the search query (Voyage unavailable).");
  }

  const candidates = await Store.aggregate([
    {
      $vectorSearch: {
        index: STORE_VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector,
        numCandidates: 150,
        limit: 50,
      },
    },
    {
      $project: {
        embedding: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]);
  if (!candidates.length) {
    return { results: [], matchTier: null, externalSuggestions: null };
  }

  const vendorIds = [...new Set(candidates.map((c) => String(c.vendorId)))];
  const vendors = await User.find({ _id: { $in: vendorIds } }).select(
    "geo trustScore area state phone",
  );
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));

  const mapResult = ({ store, vendor, distanceKm, score }) => ({
    storeId: store._id,
    // Lets the frontend cross-reference a store result against products
    // results from the same turn (dual-intent queries call both
    // searchProducts and searchStores) — without this, the same vendor
    // could render twice with no way to tell it's one vendor.
    vendorId: vendor._id,
    handle: store.handle,
    name: store.name,
    description: store.description,
    sectors: store.sectors,
    // Same precedence as searchProducts' own mapper: Store.whatsapp is the
    // number a vendor can update any time from their store settings, so
    // it's more likely current than vendor.phone (captured once at
    // onboarding and never revisited) — but either can be the only one
    // actually set, and a missing chat button was a real bug found live.
    whatsapp: store.whatsapp || vendor.phone || null,
    area: vendor.area,
    state: vendor.state,
    distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
    score: Math.round(score * 1000) / 1000,
  });

  const rankArgs = {
    candidates,
    vendorById,
    entityKey: "store",
    embeddingTextFn: storeEmbeddingText,
    queryText,
    rerankFloor: STORE_RERANK_FLOOR,
    rawScoreFloor: STORE_RAW_SCORE_FLOOR,
    limit,
    deadlineAt,
  };

  const hasLocation = typeof lat === "number" && typeof lng === "number";

  if (!hasLocation) {
    const { candidates: nationwide } = await rankCandidates({
      ...rankArgs,
      weights: NATIONWIDE_WEIGHTS,
    });
    return {
      results: nationwide.map(mapResult),
      matchTier: nationwide.length ? "nationwide" : null,
      externalSuggestions: null,
    };
  }

  const locatedArgs = { ...rankArgs, lat, lng };

  const { candidates: local } = await rankCandidates({
    ...locatedArgs,
    geoFilter: (_vendor, distanceKm) => distanceKm <= radiusKm,
    proximityReferenceKm: radiusKm,
  });
  if (local.length) {
    return {
      results: local.map(mapResult),
      matchTier: "local",
      externalSuggestions: null,
    };
  }

  // Tier 2: "nearby" — wider than Tier 1 but still a local search.
  const nearbyRadiusKm = radiusKm * NEARBY_RADIUS_MULTIPLIER;
  const { candidates: nearby } = await rankCandidates({
    ...locatedArgs,
    geoFilter: (_vendor, distanceKm) => distanceKm <= nearbyRadiusKm,
    proximityReferenceKm: nearbyRadiusKm,
  });
  if (nearby.length) {
    return {
      results: nearby.map(mapResult),
      matchTier: "nearby",
      externalSuggestions: null,
    };
  }

  // Tier 3: same state — reachable even when reverseGeocodeState fails,
  // since the tiers below (nationwide, then Google Places) don't need a
  // state name, just coordinates.
  const buyerState = await reverseGeocodeState(lat, lng);
  const { candidates: stateWide } = buyerState
    ? await rankCandidates({
        ...locatedArgs,
        geoFilter: (vendor) =>
          Boolean(vendor.state) &&
          vendor.state.toLowerCase() === buyerState.toLowerCase(),
        proximityReferenceKm: STATE_PROXIMITY_REFERENCE_KM,
      })
    : { candidates: [] };
  if (stateWide.length) {
    return {
      results: stateWide.map(mapResult),
      matchTier: "state",
      externalSuggestions: null,
    };
  }

  // Tier 4: nationwide, state-agnostic — same reasoning as searchProducts'
  // own Tier 4 above: a real vendor just across the buyer's state border
  // shouldn't lose to an external, non-Velte Google Places result.
  const { candidates: nationwide } = await rankCandidates({
    ...rankArgs,
    weights: NATIONWIDE_WEIGHTS,
  });
  if (nationwide.length) {
    return {
      results: nationwide.map(mapResult),
      matchTier: "nationwide",
      externalSuggestions: null,
    };
  }

  // Tier 5: no Velte vendor matched at all.
  const externalSuggestions = await googlePlacesFallback(queryText, lat, lng, radiusKm);

  return {
    results: [],
    matchTier: null,
    externalSuggestions,
  };
}

export { productEmbeddingText, storeEmbeddingText };
