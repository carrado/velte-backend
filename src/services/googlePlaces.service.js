// Google Places API (New) — Tier 5 fallback for searchStores, only reached
// when Velte has no matching vendor in the local, nearby, state, or
// nationwide tier.
// Isolated in its own service file the same way voyage.service.js and
// nominatim.service.js isolate their third-party calls.
//
// FieldMask requests places.id, places.displayName, places.formattedAddress,
// places.location and nothing else. displayName/formattedAddress/location
// together stay in the Text Search "Pro" SKU ($32/1,000 requests) — verified
// against Google's own docs. `id` is free to add alongside them: it lives in
// the cheapest "IDs Only" SKU, and a request bills at the highest tier any
// of its requested fields belongs to, so it costs nothing on top of the
// Pro-tier fields already being requested. It's needed as a stable dedupe
// key for recruitment-lead logging (name+address alone isn't reliable).
// Adding any Enterprise-tier field (ratings, reviews, photos, phone number)
// would push the cost into a pricier tier — deliberately not requested,
// since none of them are needed for a "here's a real nearby option, not yet
// on Velte" suggestion.

const PLACES_SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.location";
const TIMEOUT_MS = 6000;

/**
 * Real nearby businesses matching `queryText`, biased toward [lat, lng]
 * within `radiusKm`. Best-effort: returns null on any failure (missing key,
 * network error, bad response) rather than throwing — this is already the
 * last-resort tier before the model's own general-knowledge fallback, so a
 * failure here just means falling through to that, not a hard error.
 */
export async function searchNearbyBusinesses({ queryText, lat, lng, radiusKm = 10 }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(PLACES_SEARCH_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: queryText,
        locationBias: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: Math.min(radiusKm * 1000, 50000), // API caps at 50km
          },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(
        `[googlePlaces] searchText failed: ${res.status} ${await res.text()}`,
      );
      return null;
    }

    const data = await res.json();
    const places = Array.isArray(data?.places) ? data.places : [];
    return places
      .map((place) => ({
        placeId: place.id || null,
        name: place.displayName?.text || null,
        address: place.formattedAddress || null,
        lat: place.location?.latitude,
        lng: place.location?.longitude,
      }))
      .filter(
        (p) =>
          p.placeId &&
          p.name &&
          p.address &&
          typeof p.lat === "number" &&
          typeof p.lng === "number",
      );
  } catch (err) {
    console.error("[googlePlaces] searchNearbyBusinesses failed:", err.message);
    return null;
  }
}
