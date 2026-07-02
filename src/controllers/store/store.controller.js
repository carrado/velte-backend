import Store from "../../models/Store.model.js";
import Product from "../../models/Product.model.js";
import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/; // 2–30 chars, no edge hyphens
const MAX_SECTORS = 5;
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

async function getOrCreateStore(vendorId) {
  const existing = await Store.findOne({ vendorId });
  if (existing) return existing;

  const user = await User.findById(vendorId).select("company username name");
  if (!user) throw new AppError("User not found.", 404);

  const displayName = user.company?.name || user.name || "My Store";
  const base = slugify(user.company?.name || user.username || "store") || "store";

  // Find a free handle: base, then base-2, base-3, …
  let handle = base;
  for (let i = 2; await Store.exists({ handle }); i += 1) {
    handle = `${base}-${i}`;
  }

  try {
    return await Store.create({ vendorId, handle, name: displayName });
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
    res.json({ success: true, data: serializeStore(store) });
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

    if (sectors !== undefined) {
      if (!Array.isArray(sectors) || sectors.length > MAX_SECTORS) {
        throw new AppError(`Pick at most ${MAX_SECTORS} sectors.`, 400);
      }
      store.sectors = sectors
        .map((s) => String(s).trim().slice(0, 30))
        .filter(Boolean);
    }

    if (whatsapp !== undefined) {
      const digits = String(whatsapp).replace(/[^\d]/g, "");
      if (digits && (digits.length < 7 || digits.length > 15)) {
        throw new AppError("WhatsApp number looks invalid.", 400);
      }
      store.whatsapp = digits || null;
    }

    if (gallery !== undefined) {
      if (!Array.isArray(gallery) || gallery.length > MAX_GALLERY) {
        throw new AppError(`Gallery can hold at most ${MAX_GALLERY} photos.`, 400);
      }
      if (!gallery.every((u) => /^https:\/\//.test(String(u)))) {
        throw new AppError("Gallery entries must be https image URLs.", 400);
      }
      store.gallery = gallery;
    }

    await store.save();
    res.json({ success: true, data: serializeStore(store) });
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
      User.findById(store.vendorId).select("avatar area businessType"),
      Product.find({ vendorId: store.vendorId })
        .sort({ isFeatured: -1, createdAt: -1 })
        .limit(12)
        .select(
          "name price currency discountedPrice mainImageUrl description kind priceFrom",
        )
        .lean(),
    ]);

    res.json({
      success: true,
      data: {
        ...serializeStore(store),
        avatar: user?.avatar ?? null,
        area: user?.area ?? null,
        businessType: user?.businessType ?? "retail",
        products: products.map((p) => ({
          id: p._id,
          name: p.name,
          kind: p.kind ?? "product",
          priceFrom: p.priceFrom ?? false,
          price: p.price,
          currency: p.currency,
          discountedPrice: p.discountedPrice,
          mainImageUrl: p.mainImageUrl,
          description: p.description,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}
