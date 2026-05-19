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

async function graphGet(path, accessToken) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Meta API GET failed: ${path}`);
  }
  return data;
}

async function graphPost(path, accessToken, body) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Meta API POST failed: ${path}`);
  }
  return data;
}

/**
 * Fetch WhatsApp business profile for a phone number.
 */
export async function getWhatsAppBusinessProfile(phoneNumberId, accessToken) {
  const fields =
    "about,address,description,email,profile_picture_url,websites,vertical";
  const data = await graphGet(
    `/${phoneNumberId}/whatsapp_business_profile?fields=${fields}`,
    accessToken,
  );
  return data.data?.[0] ?? null;
}

/**
 * Update WhatsApp business profile (about, address, websites, vertical, etc.).
 */
export async function updateWhatsAppBusinessProfile(
  phoneNumberId,
  accessToken,
  profile,
) {
  const payload = {
    messaging_product: "whatsapp",
    about: profile.about,
    address: profile.address || "",
    description: profile.description || "",
    vertical: profile.vertical || "RETAIL",
    // Always send websites — an empty array explicitly clears existing entries on Meta.
    // Omitting the field entirely leaves the old value in place.
    websites: profile.websites ?? [],
  };

  if (profile.email) payload.email = profile.email;

  return graphPost(
    `/${phoneNumberId}/whatsapp_business_profile`,
    accessToken,
    payload,
  );
}

/**
 * Return the first catalog ID linked to a WABA, or null if none / no permission.
 */
export async function getWABACatalogId(wabaId, accessToken) {
  try {
    const data = await graphGet(
      `/${wabaId}/product_catalogs?fields=id,name`,
      accessToken,
    );
    return data.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch products from a catalog.
 */
export async function getCatalogItems(catalogId, accessToken) {
  const data = await graphGet(
    `/${catalogId}/products?fields=retailer_id,name,price,availability`,
    accessToken,
  );
  return data.data ?? [];
}

/**
 * Enable catalog visibility on the business phone number.
 */
export async function setWhatsAppCommerceSettings(
  phoneNumberId,
  accessToken,
  { isCatalogVisible = true, isCartEnabled = true } = {},
) {
  const params = new URLSearchParams();
  if (isCatalogVisible !== undefined) {
    params.set("is_catalog_visible", String(isCatalogVisible));
  }
  if (isCartEnabled !== undefined) {
    params.set("is_cart_enabled", String(isCartEnabled));
  }

  const res = await fetch(
    `${GRAPH_BASE}/${phoneNumberId}/whatsapp_commerce_settings?${params}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || "Failed to update WhatsApp commerce settings",
    );
  }
  return data;
}

/**
 * Resolve catalog ID linked to WABA, or create & link one.
 */
export async function getOrCreateWABACatalog(
  wabaId,
  accessToken,
  { businessId, catalogName = "Velte Product Catalog" } = {},
) {
  const existing = await graphGet(
    `/${wabaId}/product_catalogs?fields=id,name`,
    accessToken,
  );
  if (existing.data?.length) {
    return { catalogId: existing.data[0].id, created: false };
  }

  let resolvedBusinessId = businessId;
  if (!resolvedBusinessId) {
    const businesses = await graphGet("/me/businesses?fields=id,name", accessToken);
    resolvedBusinessId = businesses.data?.[0]?.id;
  }
  if (!resolvedBusinessId) {
    throw new Error(
      "No Meta Business account found. Connect WhatsApp in AI Setup first.",
    );
  }

  const created = await graphPost(
    `/${resolvedBusinessId}/owned_product_catalogs`,
    accessToken,
    { name: catalogName, vertical: "commerce" },
  );

  const catalogId = created.id;
  await graphPost(`/${wabaId}/product_catalogs`, accessToken, {
    catalog_id: catalogId,
  });

  return { catalogId, created: true, businessId: resolvedBusinessId };
}

/**
 * Upload a profile photo to WhatsApp Business Profile via Meta Resumable Upload API.
 *
 * Flow:
 *   1. Download the image from a public URL (Cloudinary).
 *   2. Open a Meta upload session to get a session ID.
 *   3. POST the binary to the session endpoint to get a file handle.
 *   4. Set the handle as the profile picture on the phone number.
 */
export async function uploadWhatsAppProfilePhoto(avatarUrl, phoneNumberId, accessToken) {
  // 1. Fetch image binary from Cloudinary
  const imgRes = await fetch(avatarUrl);
  if (!imgRes.ok) throw new Error("Failed to fetch avatar from Cloudinary");
  const buffer = await imgRes.arrayBuffer();
  const contentType = imgRes.headers.get("content-type") || "image/jpeg";
  const fileSize = buffer.byteLength;

  // 2. Create a resumable upload session
  const sessionParams = new URLSearchParams({
    file_length: fileSize,
    file_type: contentType,
    access_token: accessToken,
  });
  const sessionRes = await fetch(
    `${GRAPH_BASE}/${process.env.META_APP_ID}/uploads?${sessionParams}`,
    { method: "POST" },
  );
  const sessionData = await sessionRes.json();
  if (!sessionRes.ok || sessionData.error) {
    throw new Error(sessionData.error?.message || "Failed to start photo upload session");
  }
  const uploadSessionId = sessionData.id; // "upload:AYAd..."

  // 3. Upload the binary — session ID is used directly as the path segment
  const uploadRes = await fetch(`${GRAPH_BASE}/${uploadSessionId}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      "Content-Type": contentType,
      file_offset: "0",
    },
    body: buffer,
  });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok || uploadData.error) {
    throw new Error(uploadData.error?.message || "Failed to upload profile photo binary");
  }

  const handle = uploadData.h;
  if (!handle) throw new Error("Meta upload did not return a file handle");

  // 4. Set the profile picture on the phone number
  await graphPost(`/${phoneNumberId}/whatsapp_business_profile`, accessToken, {
    messaging_product: "whatsapp",
    profile_picture_handle: handle,
  });
}

/**
 * Sync up to 3 products to Meta catalog via items_batch (CREATE/UPDATE).
 */
export async function syncCatalogProducts(
  catalogId,
  accessToken,
  products,
  { currency = "NGN" } = {},
) {
  if (!products.length) return { handles: [], validation_status: [] };

  const requests = products.map((p) => ({
    method: "UPDATE",
    data: {
      id: p.retailerId,
      title: p.name,
      description: p.description || p.name,
      availability: p.inStock > 0 ? "in stock" : "out of stock",
      condition: "new",
      price: `${p.price} ${currency}`,
      image_link: p.imageUrl,
      link: p.link || "https://velte.ng",
    },
  }));

  const res = await fetch(`${GRAPH_BASE}/${catalogId}/items_batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      item_type: "PRODUCT_ITEM",
      requests,
      allow_upsert: true,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || "Failed to sync catalog products");
  }

  const errors = (data.validation_status || []).flatMap((v) => v.errors || []);
  if (errors.length) {
    throw new Error(
      errors.map((e) => e.message).join("; ") || "Catalog validation failed",
    );
  }

  return data;
}