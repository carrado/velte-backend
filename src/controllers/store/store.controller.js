import Store from "../../models/Store.model.js";
import Product from "../../models/Product.model.js";
import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import { embedAndSaveStore } from "../../services/embedding.service.js";
import { sectorLabel, mergeBusinessTypeFromLabels } from "../../utils/sectorLabels.js";
import { getOrCreateWallet } from "../wallet/wallet.controller.js";

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/; // 2–30 chars, no edge hyphens
const MAX_GALLERY = 6;

function slugify(source) {
  return source
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

// `seed` (signup's own description/sector/phone, see auth.js register) is
// only applied at first creation. An existing store is backfilled instead:
// any sector/WhatsApp still blank gets pulled from the signup profile — but
// never overwrites a value the vendor has already edited themselves — so
// stores created before this existed (or lazily, with no seed) still end up
// reflecting what the vendor already gave at signup.
export async function getOrCreateStore(vendorId, seed = {}) {
  const existing = await Store.findOne({ vendorId });
  if (existing) {
    let changed = false;

    // Self-heal stores seeded by the old bug, which wrote the raw signup
    // slug (e.g. "catering_event_food") into sectors instead of its display
    // label — the Store editor's chips only ever matched on the label, so
    // this silently showed as nothing selected. sectorLabel() is a no-op on
    // values that are already labels, so this is safe to run unconditionally.
    const normalizedSectors = existing.sectors.map(sectorLabel);
    if (
      JSON.stringify(normalizedSectors) !== JSON.stringify(existing.sectors)
    ) {
      existing.sectors = normalizedSectors;
      changed = true;
    }

    // Backfill for stores that predate signup auto-provisioning, or whose
    // seed was otherwise missed — never overwrites a value the vendor has
    // already set themselves via the Store editor.
    const needsSectors = existing.sectors.length === 0;
    const needsWhatsapp = !existing.whatsapp;
    if (needsSectors || needsWhatsapp) {
      const profile = await User.findById(vendorId).select("sectors phone");
      if (needsSectors && profile?.sectors?.length) {
        existing.sectors = profile.sectors.map(sectorLabel);
        changed = true;
      }
      if (needsWhatsapp && profile?.phone) {
        existing.whatsapp = profile.phone;
        changed = true;
      }
    }

    if (changed) await existing.save();
    return existing;
  }

  const user = await User.findById(vendorId).select(
    "company username name sectors phone",
  );
  if (!user) throw new AppError("User not found.", 404);

  const displayName = user.company?.name || user.name || "My Store";
  const base =
    slugify(user.company?.name || user.username || "store") || "store";

  // Find a free handle: base, then base-2, base-3, …
  let handle = base;
  for (let i = 2; await Store.exists({ handle }); i += 1) {
    handle = `${base}-${i}`;
  }

  const sectors = seed.sectors?.length
    ? seed.sectors.map(sectorLabel)
    : user.sectors?.length
      ? user.sectors.map(sectorLabel)
      : [];
  const whatsapp = seed.whatsapp || user.phone || null;

  try {
    const created = await Store.create({
      vendorId,
      handle,
      name: displayName,
      ...(seed.description ? { description: seed.description } : {}),
      ...(sectors.length ? { sectors } : {}),
      ...(whatsapp ? { whatsapp } : {}),
    });

    // Provision the vendor's wallet (incl. starter credit) right away rather
    // than lazily on first wallet-page visit or first search — staffly-ai-
    // backend's search-time wallet-eligibility filter only ever READS a
    // wallet, it never creates one (see that repo's README), so a vendor
    // whose store/products could now appear in search must already have one.
    // Fire-and-forget: a transient failure here shouldn't block store
    // creation, and getOrCreateWallet is idempotent — the wallet page's own
    // getWallet call would create it anyway on next visit.
    getOrCreateWallet(vendorId).catch((err) => {
      console.error(`[store] wallet provisioning failed for ${vendorId}:`, err.message);
    });

    return created;
  } catch (err) {
    // Concurrent first-visit race — the unique vendorId index makes the loser
    // land here; return the winner's document.
    if (err.code === 11000) {
      const store = await Store.findOne({ vendorId });
      if (store) return store;
    }
    throw err;
  }
}

function serializeConnectedCatalog(cat) {
  if (!cat) return null;
  return {
    sourceUrl: cat.sourceUrl,
    platform: cat.platform,
    status: cat.status,
    productCount: cat.productCount ?? 0,
    connectedAt: cat.connectedAt ?? null,
    lastSyncedAt: cat.lastSyncedAt ?? null,
  };
}

// Shared, public-safe shape (also spread into the public storefront). The
// connected-catalog details are vendor-private — added only in getMyStore.
function serializeStore(store) {
  return {
    handle: store.handle,
    name: store.name,
    description: store.description,
    sectors: store.sectors,
    whatsapp: store.whatsapp,
    gallery: store.gallery,
  };
}

// ── GET /api/store/me ────────────────────────────────────────────────────────

export async function getMyStore(req, res, next) {
  try {
    const store = await getOrCreateStore(req.user.userId);
    res.json({
      success: true,
      data: {
        ...serializeStore(store),
        connectedCatalog: serializeConnectedCatalog(store.connectedCatalog),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── PUT /api/store/me ────────────────────────────────────────────────────────

export async function updateMyStore(req, res, next) {
  try {
    const store = await getOrCreateStore(req.user.userId);
    const { handle, name, description, sectors, whatsapp, gallery } =
      req.body ?? {};

    // Sectors are no longer edited here — they're canonical on User.sectors
    // (set at signup, edited via PATCH /auth/sectors) and this store's own
    // `sectors` is just that list's derived display-label cache. Reject
    // rather than silently ignore, so a stale client build fails loudly
    // instead of writing to a field nothing else reads from anymore.
    if (sectors !== undefined) {
      throw new AppError(
        "Sectors are managed via your account's sectors, not the store profile.",
        400,
      );
    }

    if (handle !== undefined) {
      const next_ = String(handle).toLowerCase().trim();
      if (!HANDLE_RE.test(next_)) {
        throw new AppError(
          "Handle must be 2–30 characters: lowercase letters, numbers and hyphens.",
          400,
        );
      }
      if (next_ !== store.handle) {
        if (await Store.exists({ handle: next_ })) {
          throw new AppError("That handle is already taken.", 409);
        }
        store.handle = next_;
      }
    }

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed || trimmed.length > 80) {
        throw new AppError("Store name must be 1–80 characters.", 400);
      }
      store.name = trimmed;
    }

    if (description !== undefined) {
      const trimmed = String(description).trim();
      if (trimmed.length > 600) {
        throw new AppError("Description must be 600 characters or fewer.", 400);
      }
      store.description = trimmed;
    }

    if (whatsapp !== undefined) {
      let digits = String(whatsapp).replace(/[^\d]/g, "");
      if (digits && (digits.length < 7 || digits.length > 15)) {
        throw new AppError("WhatsApp number looks invalid.", 400);
      }
      // wa.me deep links need the full international number (country code,
      // no leading 0) — a vendor typing their number in local Nigerian
      // format ("0801...") would otherwise save a value that silently
      // breaks every "Chat on WhatsApp" link (see velte's buildWhatsappLink,
      // which normalizes defensively at render time too).
      if (digits.startsWith("0")) digits = `234${digits.slice(1)}`;
      store.whatsapp = digits || null;
    }

    if (gallery !== undefined) {
      if (!Array.isArray(gallery) || gallery.length > MAX_GALLERY) {
        throw new AppError(
          `Gallery can hold at most ${MAX_GALLERY} photos.`,
          400,
        );
      }
      if (!gallery.every((u) => /^https:\/\//.test(String(u)))) {
        throw new AppError("Gallery entries must be https image URLs.", 400);
      }
      store.gallery = gallery;
    }

    await store.save();
    // Description/sectors/name may have changed — re-embed. Fire-and-forget:
    // never block the store update on a third-party AI call.
    embedAndSaveStore(store);
    res.json({
      success: true,
      data: {
        ...serializeStore(store),
        connectedCatalog: serializeConnectedCatalog(store.connectedCatalog),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/store/connect-catalog ──────────────────────────────────────────
// Connected Catalogs (spec §16.1). The vendor pastes their own store URL; we
// probe it to detect the platform and count products, then record the source so
// the sync-mirror pipeline can ingest it. Sync-mirror, not live proxy — the
// vendor's site stays the source of truth.

const PROBE_TIMEOUT_MS = 6000;

/** Reject non-http(s) URLs and obvious internal targets (basic SSRF guard). */
function normalizeSourceUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) throw new AppError("Enter your website address.", 400);
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("That doesn't look like a valid website address.", 400);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new AppError("Only http and https addresses are supported.", 400);
  }
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) {
    throw new AppError("That address can't be reached publicly.", 400);
  }
  // Store the origin — adapters build their own paths off it.
  return url.origin;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "VelteConnect/1.0 (+catalog-sync)" },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect the catalog platform behind `origin` and count products. Supported
 * platforms today: WooCommerce (Store API) and Shopify (products.json). Custom
 * sites and other builders aren't auto-readable yet, so anything else is
 * recorded as "review" (not a live connection). The first-party `/velte-feed`
 * adapter (spec §16.1) is intentionally left out until we open up custom sites.
 */
async function probeCatalog(origin) {
  // 1. WooCommerce Store API — public, no auth. Total lives in X-WP-Total.
  try {
    const res = await fetchWithTimeout(
      `${origin}/wp-json/wc/store/products?per_page=1`,
    );
    if (res.ok) {
      const total = parseInt(res.headers.get("x-wp-total") || "", 10);
      const body = await res.json().catch(() => null);
      if (Array.isArray(body)) {
        return {
          platform: "woocommerce",
          status: "connected",
          productCount: Number.isFinite(total) ? total : body.length,
        };
      }
    }
  } catch {
    /* fall through to the next adapter */
  }

  // 2. Shopify — /products.json (public, page-paginated at 250/page). Walk the
  //    pages for an exact count, capped so a huge store can't stall the request.
  try {
    const SHOPIFY_PAGE_SIZE = 250;
    const SHOPIFY_MAX_PAGES = 20; // safety cap: counts up to 5,000 products
    let total = 0;
    let isShopify = false;

    for (let page = 1; page <= SHOPIFY_MAX_PAGES; page += 1) {
      const res = await fetchWithTimeout(
        `${origin}/products.json?limit=${SHOPIFY_PAGE_SIZE}&page=${page}`,
      );
      if (!res.ok) break;
      const body = await res.json().catch(() => null);
      if (!body || !Array.isArray(body.products)) break;
      if (page === 1) isShopify = true; // first valid page confirms Shopify
      total += body.products.length;
      // A short (or empty) page is the last one — stop walking.
      if (body.products.length < SHOPIFY_PAGE_SIZE) break;
    }

    if (isShopify) {
      return { platform: "shopify", status: "connected", productCount: total };
    }
  } catch {
    /* fall through */
  }

  // Not a supported platform — record it as "review" (a demand signal for which
  // builders vendors want) but don't claim a live connection.
  return { platform: "unknown", status: "review", productCount: 0 };
}

export async function connectCatalog(req, res, next) {
  try {
    const sourceUrl = normalizeSourceUrl(req.body?.source_url);
    const probe = await probeCatalog(sourceUrl);

    const store = await getOrCreateStore(req.user.userId);
    store.connectedCatalog = {
      sourceUrl,
      platform: probe.platform,
      status: probe.status,
      productCount: probe.productCount,
      connectedAt: new Date(),
      lastSyncedAt: null,
    };
    await store.save();

    res.json({
      success: true,
      data: serializeConnectedCatalog(store.connectedCatalog),
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/store/by-vendor/:vendorId ───────────────────────────────────────
// Public — no auth. Used by /api/search (velte frontend) to attach the
// matched product's own vendor storefront alongside its product card — a
// buyer asking "where can I find this" wants both the item AND who sells it,
// not just a WhatsApp number buried in the product card (Velte Connect's own
// "the store is the unit of the marketplace" point). Deliberately a plain
// data lookup, not a searchStores tool call: the LLM never needs to decide
// to fetch this, so it can't burn tool-call budget on it either.

export async function getStoreByVendorId(req, res, next) {
  try {
    const store = await Store.findOne({ vendorId: req.params.vendorId });
    if (!store) throw new AppError("Store not found.", 404);

    res.json({
      success: true,
      data: { storeId: store._id, ...serializeStore(store) },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/store/by-handle/:handle ─────────────────────────────────────────
// Public — no auth. Powers the /store/:handle page: store profile + vendor
// display bits + a slice of their catalog.

export async function getPublicStore(req, res, next) {
  try {
    const handle = String(req.params.handle).toLowerCase();
    const store = await Store.findOne({ handle });
    if (!store) throw new AppError("Store not found.", 404);

    const [user, products] = await Promise.all([
      User.findById(store.vendorId).select("avatar area"),
      Product.find({ vendorId: store.vendorId, isSuspended: { $ne: true } })
        .sort({ isFeatured: -1, createdAt: -1 })
        .limit(12)
        .select(
          "name price priceMax currency mainImageUrl videoUrl description kind quoteOnRequest attributes",
        )
        .lean(),
    ]);

    res.json({
      success: true,
      data: {
        ...serializeStore(store),
        // Needed by the search flow's getVendorProducts tool result so a
        // buyer's later "Chat on WhatsApp" click can bill the right vendor's
        // wallet (see search.controller.js's chargeLead) — not exposed via
        // the shared serializeStore since getMyStore has no such use for it.
        vendorId: store.vendorId,
        avatar: user?.avatar ?? null,
        area: user?.area ?? null,
        // Shim: keeps the API response shape stable for the frontend (which
        // still reads PublicStore.businessType) now that the account no
        // longer stores one frozen businessType — derived fresh from the
        // store's current sectors instead, so it also reflects any sectors
        // added/removed after signup.
        businessType: mergeBusinessTypeFromLabels(store.sectors) ?? "retail",
        products: products.map((p) => ({
          id: p._id,
          name: p.name,
          kind: p.kind ?? "product",
          quoteOnRequest: p.quoteOnRequest ?? false,
          price: p.price,
          priceMax: p.priceMax ?? null,
          currency: p.currency,
          mainImageUrl: p.mainImageUrl,
          videoUrl: p.videoUrl ?? null,
          description: p.description,
          attributes: (p.attributes || []).map((a) => ({
            name: a.name,
            value: a.value,
          })),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/store/sitemap-handles ───────────────────────────────────────────
// Public — no auth. Feeds velte's src/app/sitemap.ts so every storefront is
// discoverable by search engines, not just the ones a crawler happens to
// stumble onto via a link. Deliberately minimal (handle + updatedAt only,
// same shape a sitemap <url> entry needs) — this is not a general "list
// stores" API. Excludes vendors hidden from search or blocked, same filter
// discovery already applies elsewhere (see retrieval.service.js's
// hiddenFromSearch check) — a page search engines shouldn't be surfacing
// buyers to anyway shouldn't be in the sitemap either.
export async function listStoreHandlesForSitemap(req, res, next) {
  try {
    const hiddenVendorIds = await User.find({
      $or: [{ hiddenFromSearch: true }, { isBlocked: true }],
    }).distinct("_id");

    const stores = await Store.find({ vendorId: { $nin: hiddenVendorIds } })
      .select("handle updatedAt")
      .lean();

    res.json({
      success: true,
      data: stores.map((s) => ({ handle: s.handle, updatedAt: s.updatedAt })),
    });
  } catch (err) {
    next(err);
  }
}
