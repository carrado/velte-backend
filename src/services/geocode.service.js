// Forward geocoding — free-text address → { lat, lng }. The counterpart to
// velte (frontend)'s /api/geo/reverse, but server-side here since it's
// needed at registration time (see auth.js's register) and by the vendor-geo
// backfill script, neither of which can call the frontend's own BFF route.
//
// Two providers, deliberately NOT one-primary-with-fallback:
//   - Google (geocodeVendorAddressGoogle) for live registration — accuracy
//     matters there and volume is naturally low (once per signup), so cost
//     stays negligible even at scale. Nigerian addresses are informal/
//     landmark-style far more often than not, and Google's dataset handles
//     that meaningfully better than OSM's patchy Nigerian road coverage.
//   - Nominatim (geocodeVendorAddressNominatim) for the one-off backfill
//     script only — free, and a manual/rare bulk operation is exactly what
//     Nominatim's usage policy tolerates, unlike routing production
//     registration traffic through it.
// Reuses GOOGLE_PLACES_API_KEY (this repo's existing name for it, from the
// Google Places fallback in search) — same underlying Maps Platform key the
// frontend uses as GOOGLE_MAPS_API_KEY, just enabled for the Geocoding API
// too now.

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

/** Best-effort: null on no match/bad input/failure, never throws. */
async function forwardGeocodeGoogle(addressText) {
  if (typeof addressText !== "string" || !addressText.trim()) return null;
  // Read lazily, not cached at module load — a standalone script that calls
  // dotenv.config() itself (rather than through the app's loadEnv.js-first
  // entry point) hoists this module's import above that config() call under
  // ESM's import-hoisting rules, so a top-level `const ... = process.env...`
  // here would capture undefined permanently. Cost of reading it per-call is
  // negligible next to a network request anyway.
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `${GOOGLE_GEOCODE_URL}?address=${encodeURIComponent(
      addressText,
    )}&region=ng&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    if (data.status !== "OK" || !data.results?.length) return null;

    const { lat, lng } = data.results[0].geometry?.location ?? {};
    if (typeof lat !== "number" || typeof lng !== "number") return null;

    return { lat, lng };
  } catch (err) {
    console.error("[geocode] forwardGeocodeGoogle failed:", err.message);
    return null;
  }
}

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
// Same identity Nominatim already sees from the frontend's reverse-geocode
// route — one consistent User-Agent per app, not per-service.
const USER_AGENT = "Velte/1.0 (https://velte.ng)";

/** Best-effort: null on no match/bad input/failure, never throws. */
async function forwardGeocodeNominatim(addressText) {
  if (typeof addressText !== "string" || !addressText.trim()) return null;

  try {
    const url = `${NOMINATIM_SEARCH_URL}?format=jsonv2&q=${encodeURIComponent(
      addressText,
    )}&countrycodes=ng&limit=1`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;

    const results = await res.json();
    const hit = results?.[0];
    if (!hit) return null;

    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return { lat, lng };
  } catch (err) {
    console.error("[geocode] forwardGeocodeNominatim failed:", err.message);
    return null;
  }
}

/**
 * A vendor's typed address is sometimes too messy for even Google to pin
 * precisely (multiple place names run together, informal descriptions) —
 * rather than leave that vendor with no geo point at all, fall back to just
 * the state name. A coarse state-level pin still gets them into the
 * state-tier search (see retrieval.service.js's tiers), which beats being
 * invisible to every location-scoped tier forever.
 */
export async function geocodeVendorAddressGoogle(address, state) {
  const full = [address, state, "Nigeria"].filter(Boolean).join(", ");
  const preciseCoords = await forwardGeocodeGoogle(full);
  if (preciseCoords) return preciseCoords;

  if (!state) return null;
  return forwardGeocodeGoogle(`${state}, Nigeria`);
}

/** Same two-step idea as geocodeVendorAddressGoogle, Nominatim-backed. */
export async function geocodeVendorAddressNominatim(address, state) {
  const full = [address, state, "Nigeria"].filter(Boolean).join(", ");
  const preciseCoords = await forwardGeocodeNominatim(full);
  if (preciseCoords) return preciseCoords;

  if (!state) return null;
  // Nominatim's free-use policy caps requests at 1/second — this fallback
  // is a second call for the same vendor, so it must pace itself rather
  // than assume the caller does (registration calls this once per signup
  // with no pacing of its own; only the backfill script's outer loop does).
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  return forwardGeocodeNominatim(`${state}, Nigeria`);
}
