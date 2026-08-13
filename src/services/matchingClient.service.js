// Calls staffly-ai-backend's internal matching endpoint to find vendors for
// a Buyer Request. Per docs/velte_buyer_requests_mvp_spec.md's confirmed
// fork: the actual semantic+proximity+trust ranking engine stays
// single-sourced in staffly-ai-backend (see that repo's retrieval.service.js)
// rather than being duplicated a third time into this repo — this is a
// network call to a NEW internal (not buyer-facing) endpoint there, guarded
// by a shared secret since it's service-to-service, not public.
//
// Best-effort by design: a request must still be created even if matching
// fails or the sibling service is down (spec §14, "do not reject the
// request" — the same principle extended to "don't fail request creation
// over a matching-service hiccup either"). Callers get an empty match list
// on any failure, never a thrown error.

const MATCHING_SERVICE_URL = process.env.STAFFLY_AI_BACKEND_URL;
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET;

/**
 * @param {{ queryText: string, lat?: number, lng?: number, imageUrl?: string }} params
 * @returns {Promise<string[]>} matched vendor ObjectId strings, deduped
 */
export async function matchBuyerRequestToVendors({ queryText, lat, lng, imageUrl }) {
  if (!MATCHING_SERVICE_URL || !INTERNAL_SERVICE_SECRET) {
    console.error(
      "[matchingClient] STAFFLY_AI_BACKEND_URL / INTERNAL_SERVICE_SECRET not configured — " +
        "returning no matches rather than blocking request creation.",
    );
    return [];
  }

  try {
    const res = await fetch(`${MATCHING_SERVICE_URL}/api/internal/match-buyer-request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SERVICE_SECRET,
      },
      body: JSON.stringify({ queryText, lat, lng, imageUrl }),
    });

    if (!res.ok) {
      console.error(`[matchingClient] matching service returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    return Array.isArray(data?.data?.matchedVendorIds) ? data.data.matchedVendorIds : [];
  } catch (err) {
    console.error("[matchingClient] request failed:", err.message);
    return [];
  }
}
