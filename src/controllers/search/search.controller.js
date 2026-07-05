import {
  searchProducts as findProducts,
  searchStores as findStores,
} from "../../services/retrieval.service.js";
import { AppError } from "../../middleware/errorHandler.js";
import RecruitmentLead from "../../models/RecruitmentLead.model.js";

// ── POST /api/search/products ─────────────────────────────────────────────────
// Public — called by the frontend's searchProducts tool, for a buyer naming a
// specific item. Never directly by a buyer's browser. All ranking/matching
// logic lives in retrieval.service.js; this is just the HTTP wrapper.
// (Renamed from searchVendors/`/vendors` — that name was the root of the
// product-vs-vendor confusion this endpoint's sibling, searchStores, fixes.)

export async function searchProducts(req, res, next) {
  try {
    const { queryText, lat, lng, radiusKm, limit, isImageQuery, imageUrl } =
      req.body ?? {};

    if (typeof queryText !== "string" || !queryText.trim()) {
      throw new AppError("queryText is required.", 400);
    }
    // Both present (a located search) or both absent (a nationwide search,
    // no distance ranking) are valid; only a partial pair is malformed.
    const hasLat = typeof lat === "number";
    const hasLng = typeof lng === "number";
    if (hasLat !== hasLng) {
      throw new AppError(
        "lat and lng must be provided together, or both omitted for a nationwide search.",
        400,
      );
    }

    const { results, matchTier, matchQuality } = await findProducts({
      queryText,
      lat: hasLat ? lat : undefined,
      lng: hasLng ? lng : undefined,
      radiusKm: typeof radiusKm === "number" ? radiusKm : undefined,
      limit: typeof limit === "number" ? limit : undefined,
      isImageQuery: Boolean(isImageQuery),
      imageUrl: typeof imageUrl === "string" ? imageUrl : undefined,
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
    const hasLat = typeof lat === "number";
    const hasLng = typeof lng === "number";
    if (hasLat !== hasLng) {
      throw new AppError(
        "lat and lng must be provided together, or both omitted for a nationwide search.",
        400,
      );
    }

    const { results, matchTier, externalSuggestions } = await findStores({
      queryText,
      lat: hasLat ? lat : undefined,
      lng: hasLng ? lng : undefined,
      radiusKm: typeof radiusKm === "number" ? radiusKm : undefined,
      limit: typeof limit === "number" ? limit : undefined,
    });

    res.json({ success: true, data: { results, matchTier, externalSuggestions } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/log ──────────────────────────────────────────────────────
// Public — called once per buyer turn from the frontend's /api/search route,
// after the full LLM turn resolves. Deliberately NOT a general demand log of
// every query (that used to write raw query text + the buyer's precise
// coordinates to the DB for every search, matched or not — removed: nothing
// should persist beyond the conversation itself unless there's a real
// business reason to). The one real reason to persist anything here: when
// Velte had no vendor for a request AND Google Places surfaced a real,
// unlisted business nearby — that's a recruitment opportunity, worth
// tracking so the company can follow up and get that business onto Velte.
// A turn with nothing to report (matched fine, or nothing found anywhere)
// writes nothing at all.

export async function logSearch(req, res, next) {
  try {
    const { rawQuery, parsedProduct, externalStoreSuggestions } = req.body ?? {};

    if (!Array.isArray(externalStoreSuggestions) || !externalStoreSuggestions.length) {
      res.json({ success: true });
      return;
    }

    const matchedQuery =
      (typeof parsedProduct === "string" && parsedProduct) ||
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
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
