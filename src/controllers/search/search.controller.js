import {
  searchProducts as findProducts,
  searchStores as findStores,
} from "../../services/retrieval.service.js";
import { AppError } from "../../middleware/errorHandler.js";
import Search from "../../models/Search.model.js";
import RecruitmentLead from "../../models/RecruitmentLead.model.js";

// ── POST /api/search/products ─────────────────────────────────────────────────
// Public — called by the frontend's searchProducts tool, for a buyer naming a
// specific item. Never directly by a buyer's browser. All ranking/matching
// logic lives in retrieval.service.js; this is just the HTTP wrapper.
// (Renamed from searchVendors/`/vendors` — that name was the root of the
// product-vs-vendor confusion this endpoint's sibling, searchStores, fixes.)

export async function searchProducts(req, res, next) {
  try {
    const { queryText, lat, lng, radiusKm, limit, isImageQuery } = req.body ?? {};

    if (typeof queryText !== "string" || !queryText.trim()) {
      throw new AppError("queryText is required.", 400);
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      throw new AppError("lat/lng must be numbers.", 400);
    }

    const { results, matchTier, matchQuality } = await findProducts({
      queryText,
      lat,
      lng,
      radiusKm: typeof radiusKm === "number" ? radiusKm : undefined,
      limit: typeof limit === "number" ? limit : undefined,
      isImageQuery: Boolean(isImageQuery),
    });

    res.json({ success: true, data: { results, matchTier, matchQuality } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/stores ───────────────────────────────────────────────────
// Public — called by the frontend's searchStores tool, for a buyer describing
// a kind of business/vendor/shop rather than a specific item.

export async function searchStores(req, res, next) {
  try {
    const { queryText, lat, lng, radiusKm, limit } = req.body ?? {};

    if (typeof queryText !== "string" || !queryText.trim()) {
      throw new AppError("queryText is required.", 400);
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      throw new AppError("lat/lng must be numbers.", 400);
    }

    const { results, matchTier, externalSuggestions } = await findStores({
      queryText,
      lat,
      lng,
      radiusKm: typeof radiusKm === "number" ? radiusKm : undefined,
      limit: typeof limit === "number" ? limit : undefined,
    });

    res.json({ success: true, data: { results, matchTier, externalSuggestions } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/log ──────────────────────────────────────────────────────
// Public — called once per buyer turn from the frontend's /api/search route
// (build-order step f), after the full LLM turn resolves. Demand log: every
// query is worth keeping, matched or not, tool-called or not.

export async function logSearch(req, res, next) {
  try {
    const {
      rawQuery,
      hadImage,
      parsed,
      matched,
      resultVendorIds,
      resultStoreIds,
      usedExternalFallback,
      buyerLat,
      buyerLng,
      externalStoreSuggestions,
    } = req.body ?? {};

    if (typeof matched !== "boolean") {
      throw new AppError("matched must be a boolean.", 400);
    }

    await Search.create({
      rawQuery: typeof rawQuery === "string" ? rawQuery : null,
      hadImage: Boolean(hadImage),
      parsed: parsed ?? null,
      matched,
      resultVendorIds: Array.isArray(resultVendorIds) ? resultVendorIds : [],
      resultStoreIds: Array.isArray(resultStoreIds) ? resultStoreIds : [],
      usedExternalFallback: Boolean(usedExternalFallback),
      buyerLat: typeof buyerLat === "number" ? buyerLat : null,
      buyerLng: typeof buyerLng === "number" ? buyerLng : null,
    });

    // Best-effort recruitment-lead upsert — never throws, never blocks the
    // primary demand-log write above (same convention as
    // embedAndSaveProduct/embedAndSaveStore in retrieval.service.js).
    if (Array.isArray(externalStoreSuggestions) && externalStoreSuggestions.length) {
      const matchedQuery =
        (parsed && typeof parsed.product === "string" && parsed.product) ||
        (typeof rawQuery === "string" ? rawQuery : null);

      await Promise.all(
        externalStoreSuggestions.map((s) => {
          if (
            !s ||
            typeof s.placeId !== "string" ||
            typeof s.name !== "string" ||
            typeof s.address !== "string" ||
            typeof s.lat !== "number" ||
            typeof s.lng !== "number"
          ) {
            return null;
          }
          return RecruitmentLead.findOneAndUpdate(
            { placeId: s.placeId },
            {
              $set: {
                name: s.name,
                address: s.address,
                location: { type: "Point", coordinates: [s.lng, s.lat] },
                lastSeenAt: new Date(),
              },
              $inc: { hitCount: 1 },
              ...(matchedQuery
                ? { $push: { matchedQueries: { $each: [matchedQuery], $slice: -20 } } }
                : {}),
            },
            { upsert: true },
          );
        }),
      ).catch((err) => {
        console.error("[search] recruitment lead upsert failed:", err.message);
      });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
