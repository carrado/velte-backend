// src/services/meta.service.js
const GRAPH_BASE = "https://graph.facebook.com/v19.0";

/**
 * Verify a short-lived token from the FB JS SDK belongs to OUR app,
 * then upgrade it to a long-lived token (~60 days).
 *
 * WHY NOT USE THE CODE?
 * The FB JS SDK issues PKCE-style codes that can only be exchanged by
 * Facebook's own servers — no redirect_uri works from a third-party backend.
 * The correct approach for JS SDK is to receive the accessToken directly
 * and upgrade it server-side.
 *
 * @param {string} shortLivedToken - accessToken from FB SDK response.authResponse.accessToken
 * @returns {{ accessToken: string, expiresIn: number, userId: string }}
 */
export async function exchangeSDKToken(shortLivedToken) {
  // Step 1: Verify token is genuine and belongs to our app (prevents injection attacks)
  await verifyToken(shortLivedToken);

  // Step 2: Upgrade to long-lived token (~60 days)
  const longLived = await getLongLivedToken(shortLivedToken);

  // Step 3: Fetch the real userId from Graph API server-side
  const me = await fetchMetaMe(longLived.accessToken);

  return {
    accessToken: longLived.accessToken,
    expiresIn: longLived.expiresIn,
    userId: me.id,
  };
}

/**
 * Verify a user token is genuine and belongs to OUR specific app.
 * This prevents token injection where an attacker passes a token from another app.
 */
async function verifyToken(accessToken) {
  const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
  const res = await fetch(
    `${GRAPH_BASE}/debug_token?input_token=${accessToken}&access_token=${appToken}`,
  );
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || "Failed to verify Meta token");
  }

  const info = data.data;

  if (String(info.app_id) !== String(process.env.META_APP_ID)) {
    throw new Error("Token does not belong to this application");
  }

  if (!info.is_valid) {
    throw new Error(
      "Meta token is invalid or expired. Please log in with Facebook again.",
    );
  }
}

/**
 * Exchange a short-lived token for a long-lived one (~60 days).
 */
async function getLongLivedToken(shortLivedToken) {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: shortLivedToken,
  });

  const res = await fetch(`${GRAPH_BASE}/oauth/access_token?${params}`);
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || "Failed to upgrade to long-lived Meta token",
    );
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch the authenticated Meta user's ID and name from Graph API.
 */
async function fetchMetaMe(accessToken) {
  const res = await fetch(
    `${GRAPH_BASE}/me?fields=id,name&access_token=${accessToken}`,
  );
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || "Failed to fetch Meta user profile");
  }

  return data; // { id, name }
}

/**
 * Fetch all phone numbers registered to a WhatsApp Business Account.
 */
export async function fetchWABAPhoneNumbers(wabaId, accessToken) {
  const fields = "display_phone_number,verified_name,status,quality_rating";
  const res = await fetch(
    `${GRAPH_BASE}/${wabaId}/phone_numbers?fields=${fields}&access_token=${accessToken}`,
  );
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || "Failed to fetch WhatsApp phone numbers",
    );
  }

  return (data.data || []).map((num) => ({
    numberId: num.id,
    phoneNumber: num.display_phone_number,
    displayName: num.verified_name || num.display_phone_number,
    businessName: num.verified_name || "Unknown Business",
    verificationStatus: normaliseStatus(num.status),
  }));
}

/**
 * Register a webhook for a specific phone number.
 */
export async function subscribeToWebhook(wabaId, accessToken) {
  const res = await fetch(`${GRAPH_BASE}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || "Failed to subscribe app to phone number",
    );
  }

  return data;
}

function normaliseStatus(metaStatus) {
  if (!metaStatus) return "unverified";
  const s = metaStatus.toUpperCase();
  if (s === "VERIFIED") return "verified";
  if (s === "PENDING") return "pending";
  return "unverified";
}
