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
import { embed, rerank } from "./voyage.service.js";
import { reverseGeocodeState } from "./nominatim.service.js";
import { searchNearbyBusinesses } from "./googlePlaces.service.js";

const VECTOR_INDEX_NAME = "product_vector_index";
const STORE_VECTOR_INDEX_NAME = "store_vector_index";

const WEIGHTS = {
  semantic: 0.5,
  proximity: 0.3,
  trust: 0.2,
};

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
// scales (documented above). Reasoned, not yet validated against real
// image-search data — revisit once there's a varied enough catalog to
// calibrate against, same as RERANK_FLOOR/RAW_SCORE_FLOOR originally were.
const DIRECT_MATCH_MARGIN = 0.15;

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

/** Embed a product and persist the vector. Best-effort — never throws. */
export async function embedAndSaveProduct(product) {
  try {
    const vectors = await embed([productEmbeddingText(product)], "document");
    if (!vectors?.[0]) return;
    await Product.updateOne(
      { _id: product._id },
      { $set: { embedding: vectors[0] } },
    );
  } catch (err) {
    console.error("[retrieval] embedAndSaveProduct failed:", err.message);
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
 * Shared core for both searchProducts and searchStores: join vendors, apply
 * a geo filter (different per tier), rerank/floor, and rank by
 * semantic + proximity + trust. `entityKey` is "product" or "store" — the
 * caller does its own entity-specific field mapping afterward, since
 * VendorMatch/StoreMatch have different shapes.
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
}) {
  const withVendor = candidates
    .map((entity) => {
      const vendor = vendorById.get(String(entity.vendorId));
      if (!vendor?.geo?.coordinates?.length) return null;
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
  );
  const relevanceFloor = rerankScores ? rerankFloor : rawScoreFloor;

  const ranked = withVendor
    .map((c, i) => ({
      ...c,
      semanticScore: rerankScores ? rerankScores[i] : c[entityKey].score,
    }))
    // Excluded here, not just re-ranked lower — a weak semantic match must
    // never reach `results`, since a UI rendering results as cards has no
    // narration to make "we don't think this is a real match" clear.
    .filter((c) => c.semanticScore >= relevanceFloor)
    .map((c) => {
      const proximityScore = Math.max(
        0,
        1 - c.distanceKm / proximityReferenceKm,
      );
      const trustComponent = (c.vendor.trustScore ?? 0) / 100;
      const score =
        WEIGHTS.semantic * c.semanticScore +
        WEIGHTS.proximity * proximityScore +
        WEIGHTS.trust * trustComponent;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { candidates: ranked, relevanceFloor };
}

/**
 * Search products by meaning + proximity + trust. Two tiers: a tight
 * radius first, then — only if that's empty — the buyer's whole state
 * (Tier 2 doesn't re-run the vector search; the same top candidates are
 * just re-filtered by state instead of distance). Throws only if the query
 * itself can't be embedded (Voyage down / no key) — that's a hard stop, not
 * a degrade, since there's nothing to search without a query vector.
 */
// Only meaningful for image-derived searches: splits a tier's already-
// ranked candidates into "direct" (clears floor + DIRECT_MATCH_MARGIN) vs
// "similar" (everything else that still cleared the base floor). A non-
// empty direct set wins outright — the merely-similar candidates are
// dropped, not just re-ranked lower, per the same "don't show a weak match
// with no way to say so" reasoning rankCandidates already applies to the
// base floor. Text queries (isImageQuery false) pass through unchanged.
function applyMatchQuality(tierCandidates, relevanceFloor, isImageQuery) {
  if (!isImageQuery || !tierCandidates.length) {
    return { candidates: tierCandidates, matchQuality: undefined };
  }
  const directFloor = relevanceFloor + DIRECT_MATCH_MARGIN;
  const direct = tierCandidates.filter((c) => c.semanticScore >= directFloor);
  return direct.length
    ? { candidates: direct, matchQuality: "direct" }
    : { candidates: tierCandidates, matchQuality: "similar" };
}

export async function searchProducts({
  queryText,
  lat,
  lng,
  radiusKm = 10,
  limit = 20,
  isImageQuery = false,
}) {
  const queryVectors = await embed([queryText], "query");
  const queryVector = queryVectors?.[0];
  if (!queryVector) {
    throw new Error("Could not embed the search query (Voyage unavailable).");
  }

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
    return { results: [], matchTier: null, matchQuality: undefined };
  }

  const vendorIds = [...new Set(candidates.map((c) => String(c.vendorId)))];
  const vendors = await User.find({ _id: { $in: vendorIds } }).select(
    "geo trustScore area state name phone avatar",
  );
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));

  const mapResult = ({ product, vendor, distanceKm, score }) => ({
    productId: product._id,
    name: product.name,
    // Product.price/priceMax are stored in kobo (AddProductPage.tsx sends
    // Math.round(price * 100)) — convert to the real Naira amount here so
    // neither the LLM nor any UI ever quotes a 100x-inflated price.
    price: product.price / 100,
    priceMax: product.priceMax != null ? product.priceMax / 100 : null,
    currency: product.currency,
    mainImageUrl: product.mainImageUrl,
    vendorId: vendor._id,
    vendorName: vendor.name,
    area: vendor.area,
    state: vendor.state,
    // No `whatsapp` field exists on User — `phone` is the actual WhatsApp
    // Business number captured at onboarding ("This should be your
    // WhatsApp Business number" in Step1BusinessAccount.tsx).
    whatsapp: vendor.phone || null,
    distanceKm: Math.round(distanceKm * 10) / 10,
    score: Math.round(score * 1000) / 1000,
  });

  const rankArgs = {
    candidates,
    vendorById,
    entityKey: "product",
    embeddingTextFn: productEmbeddingText,
    queryText,
    lat,
    lng,
    rerankFloor: RERANK_FLOOR,
    rawScoreFloor: RAW_SCORE_FLOOR,
    limit,
  };

  // Tier 1: tight radius.
  const { candidates: local, relevanceFloor: localFloor } = await rankCandidates({
    ...rankArgs,
    geoFilter: (_vendor, distanceKm) => distanceKm <= radiusKm,
    proximityReferenceKm: radiusKm,
  });
  if (local.length) {
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      local,
      localFloor,
      isImageQuery,
    );
    return { results: tiered.map(mapResult), matchTier: "local", matchQuality };
  }

  // Tier 2: same state, only if Tier 1 came up empty.
  const buyerState = await reverseGeocodeState(lat, lng);
  if (!buyerState) {
    return { results: [], matchTier: null, matchQuality: undefined };
  }

  const { candidates: stateWide, relevanceFloor: stateFloor } = await rankCandidates({
    ...rankArgs,
    geoFilter: (vendor) =>
      Boolean(vendor.state) &&
      vendor.state.toLowerCase() === buyerState.toLowerCase(),
    proximityReferenceKm: STATE_PROXIMITY_REFERENCE_KM,
  });

  if (!stateWide.length) {
    return { results: [], matchTier: null, matchQuality: undefined };
  }
  const { candidates: tiered, matchQuality } = applyMatchQuality(
    stateWide,
    stateFloor,
    isImageQuery,
  );
  return { results: tiered.map(mapResult), matchTier: "state", matchQuality };
}

/**
 * Search stores (vendors as a business) by meaning + proximity + trust —
 * for a buyer describing a *kind* of business/vendor/shop rather than a
 * specific item. Same two-tier (local, then state-wide) structure as
 * searchProducts.
 */
export async function searchStores({
  queryText,
  lat,
  lng,
  radiusKm = 10,
  limit = 20,
}) {
  const queryVectors = await embed([queryText], "query");
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
  if (!candidates.length) return { results: [], matchTier: null };

  const vendorIds = [...new Set(candidates.map((c) => String(c.vendorId)))];
  const vendors = await User.find({ _id: { $in: vendorIds } }).select(
    "geo trustScore area state",
  );
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));

  const mapResult = ({ store, vendor, distanceKm, score }) => ({
    storeId: store._id,
    handle: store.handle,
    name: store.name,
    description: store.description,
    sectors: store.sectors,
    // Store has its own `whatsapp` field (unlike User, which only has
    // `phone`) — already the field the public /store/:handle page uses.
    whatsapp: store.whatsapp,
    area: vendor.area,
    state: vendor.state,
    distanceKm: Math.round(distanceKm * 10) / 10,
    score: Math.round(score * 1000) / 1000,
  });

  const rankArgs = {
    candidates,
    vendorById,
    entityKey: "store",
    embeddingTextFn: storeEmbeddingText,
    queryText,
    lat,
    lng,
    rerankFloor: STORE_RERANK_FLOOR,
    rawScoreFloor: STORE_RAW_SCORE_FLOOR,
    limit,
  };

  const { candidates: local } = await rankCandidates({
    ...rankArgs,
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

  // Tier 2: same state — reachable even when reverseGeocodeState fails,
  // since Tier 3 below doesn't need a state name, just coordinates.
  const buyerState = await reverseGeocodeState(lat, lng);
  const { candidates: stateWide } = buyerState
    ? await rankCandidates({
        ...rankArgs,
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

  // Tier 3: no Velte vendor matched at all — real nearby businesses via
  // Google Places, clearly a different kind of result from a Velte
  // StoreMatch (no trust score, no WhatsApp, no Velte relationship).
  // Best-effort: null on any failure, same as every other stage here.
  const places = await searchNearbyBusinesses({ queryText, lat, lng, radiusKm });
  const externalSuggestions = places?.length
    ? places.map((p) => ({
        placeId: p.placeId,
        name: p.name,
        address: p.address,
        lat: p.lat,
        lng: p.lng,
        distanceKm: Math.round(haversineKm([lng, lat], [p.lng, p.lat]) * 10) / 10,
      }))
    : null;

  return { results: [], matchTier: null, externalSuggestions };
}

export { productEmbeddingText, storeEmbeddingText };
