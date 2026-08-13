import BuyerSavedItem from "../../models/BuyerSavedItem.model.js";
import Product from "../../models/Product.model.js";
import Store from "../../models/Store.model.js";
import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import { getVendorEligibilityFilter } from "../store/store.controller.js";
import { notifyUser } from "../../services/pushNotification.service.js";

const VALID_KINDS = ["product", "vendor"];

// ── POST /api/buyer-saved/toggle — { kind, targetId } ───────────────────────
// Tap-to-toggle, same heart-icon UX as everywhere else this pattern exists:
// not saved -> save it, already saved -> unsave it. Race-safe under a
// double-tap — the loser of the "not found, insert" branch collides on
// BuyerSavedItem's own unique index and is treated as a successful save
// rather than surfaced as an error, same E11000-swallowing style as
// vendorBuyerRequests.controller.js's respondToRequest.
export async function toggleSaved(req, res, next) {
  try {
    const { kind, targetId } = req.body ?? {};
    if (!VALID_KINDS.includes(kind)) {
      return next(new AppError("kind must be 'product' or 'vendor'.", 400));
    }
    if (!targetId || typeof targetId !== "string") {
      return next(new AppError("targetId is required.", 400));
    }

    const buyerId = req.buyer.buyerId;
    const existing = await BuyerSavedItem.findOne({ buyerId, kind, targetId });
    if (existing) {
      await existing.deleteOne();
      return res.status(200).json({ success: true, data: { saved: false } });
    }

    let created = true;
    try {
      await BuyerSavedItem.create({ buyerId, kind, targetId });
    } catch (err) {
      if (err.code !== 11000) throw err; // lost the race — already saved
      created = false; // the OTHER request created it — don't double-notify
    }

    // Vendor-facing alert — in-app bell + web push, never SMS (buyers get
    // SMS for their own request responses; a vendor being followed is a
    // vendor-side event and uses the vendor's own existing channel, same
    // as buyer-request match notifications). Fires once, on the actual
    // create, not on every toggle — no notification on unfollow, matching
    // every other "removal" action in this codebase. Best-effort: a failed
    // push must never fail the follow itself.
    if (kind === "vendor" && created) {
      notifyUser(targetId, {
        type: "buyer-follow",
        title: "New follower",
        body: "Someone started following your store on Velte.",
        url: `/${targetId}/store/followers`,
        tag: "buyer-follow",
      }).catch((err) => {
        console.error(
          `[buyerSaved] follow notify failed for vendor ${targetId}:`,
          err.message,
        );
      });
    }

    res.status(200).json({ success: true, data: { saved: true } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// Same serialization getMarketplaceBrowse/getVendorsBrowse already produce
// (MarketplaceBrowseItem / VendorPreviewItem) so the frontend renders a
// buyer's saved items with the exact same MarketplaceCard/VendorCard it
// already has, not a third card shape that would drift from them. Also
// applies the same getVendorEligibilityFilter every other browse surface
// does — a saved item pointing at a since-hidden/unfunded vendor silently
// drops out rather than showing a dead "Chat" button.
async function enrichSavedProducts(productIds) {
  if (productIds.length === 0) return [];

  const vendorFilter = await getVendorEligibilityFilter();
  const products = await Product.find({
    _id: { $in: productIds },
    isSuspended: { $ne: true },
    vendorId: vendorFilter,
  })
    .select(
      "vendorId name kind quoteOnRequest price priceMax currency mainImageUrl thumbnailUrls description attributes categoryId",
    )
    .lean();
  if (products.length === 0) return [];

  const vendorIds = [...new Set(products.map((p) => String(p.vendorId)))];
  const [stores, users] = await Promise.all([
    Store.find({ vendorId: { $in: vendorIds } })
      .select("vendorId name handle whatsapp")
      .lean(),
    User.find({ _id: { $in: vendorIds } })
      .select("avatar")
      .lean(),
  ]);
  const storeByVendorId = new Map(stores.map((s) => [String(s.vendorId), s]));
  const avatarByVendorId = new Map(
    users.map((u) => [String(u._id), u.avatar ?? null]),
  );

  return products
    .map((p) => {
      const store = storeByVendorId.get(String(p.vendorId));
      if (!store) return null;
      return {
        id: p._id,
        name: p.name,
        kind: p.kind ?? "product",
        quoteOnRequest: p.quoteOnRequest ?? false,
        price: p.price,
        priceMax: p.priceMax ?? null,
        currency: p.currency,
        mainImageUrl: p.mainImageUrl,
        thumbnailUrls: p.thumbnailUrls || [],
        description: p.description,
        attributes: (p.attributes || []).map((a) => ({
          name: a.name,
          value: a.value,
        })),
        categoryId: p.categoryId ?? null,
        vendorId: p.vendorId,
        storeName: store.name,
        storeHandle: store.handle,
        storeAvatar: avatarByVendorId.get(String(p.vendorId)) ?? null,
        whatsapp: store.whatsapp,
      };
    })
    .filter(Boolean);
}

async function enrichSavedVendors(vendorIds) {
  if (vendorIds.length === 0) return [];

  const vendorFilter = await getVendorEligibilityFilter();
  // Both conditions land on `vendorId` — $and, not a merged object, so the
  // saved-target $in and the eligibility filter's own $in/$nin don't
  // clobber each other.
  const stores = await Store.find({
    $and: [{ vendorId: { $in: vendorIds } }, { vendorId: vendorFilter }],
  })
    .select("vendorId name handle description sectors whatsapp gallery")
    .lean();
  if (stores.length === 0) return [];

  const users = await User.find({
    _id: { $in: stores.map((s) => s.vendorId) },
  })
    .select("avatar")
    .lean();
  const avatarByVendorId = new Map(
    users.map((u) => [String(u._id), u.avatar ?? null]),
  );

  return stores.map((s) => ({
    vendorId: s.vendorId,
    name: s.name,
    handle: s.handle,
    description: s.description || null,
    sectors: s.sectors || [],
    whatsapp: s.whatsapp,
    gallery: s.gallery || [],
    avatar: avatarByVendorId.get(String(s.vendorId)) ?? null,
  }));
}

// ── GET /api/buyer-saved/my ──────────────────────────────────────────────
export async function getMySaved(req, res, next) {
  try {
    const buyerId = req.buyer.buyerId;
    const saved = await BuyerSavedItem.find({ buyerId })
      .sort({ createdAt: -1 })
      .lean();

    const savedProductIds = saved
      .filter((s) => s.kind === "product")
      .map((s) => s.targetId);
    const savedVendorIds = saved
      .filter((s) => s.kind === "vendor")
      .map((s) => s.targetId);
    // Enrichment below re-queries by _id/vendorId, which doesn't preserve
    // Mongo's own $in order — re-sort by when the buyer actually saved
    // each one, most recent first.
    const savedAtByTarget = new Map(
      saved.map((s) => [String(s.targetId), s.createdAt]),
    );

    const [products, vendors] = await Promise.all([
      enrichSavedProducts(savedProductIds),
      enrichSavedVendors(savedVendorIds),
    ]);

    products.sort(
      (a, b) => savedAtByTarget.get(String(b.id)) - savedAtByTarget.get(String(a.id)),
    );
    vendors.sort(
      (a, b) =>
        savedAtByTarget.get(String(b.vendorId)) -
        savedAtByTarget.get(String(a.vendorId)),
    );

    res.status(200).json({ success: true, data: { products, vendors } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
