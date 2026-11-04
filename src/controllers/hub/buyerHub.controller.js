import mongoose from "mongoose";

import HubAdvert from "../../models/HubAdvert.model.js";
import HubBroadcast from "../../models/HubBroadcast.model.js";
import BuyerBroadcast from "../../models/BuyerBroadcast.model.js";
import FavouriteVendor from "../../models/FavouriteVendor.model.js";
import Store from "../../models/Store.model.js";
import Product from "../../models/Product.model.js";
import User from "../../models/Users.js";
import Buyer from "../../models/Buyer.model.js";
import PlatformSubscription from "../../models/PlatformSubscription.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { resolveTier } from "../../services/tier.service.js";
import { can } from "../../config/entitlements.js";
import {
  BUYER_ADVERT_COMMISSION_KOBO,
  HUB_ADVERT_DAYS,
  HUB_MAX_ACTIVE_ADVERTS_PER_VENDOR,
} from "../../config/prices.js";

const LIVE = ["trialing", "active", "past_due", "cancelled"];

async function premiumBuyer(req, capability) {
  if (req.actor?.type !== "buyer") {
    throw new AppError("Sign in as a buyer.", 401);
  }
  const tier = await resolveTier(req.actor);
  if (!can(tier, capability)) {
    throw new AppError("That is part of Buyer Premium.", 403, {
      code: "upgrade_required",
      capability,
    });
  }
  return tier;
}

function cleanText(value, max, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new AppError(`${label} is required.`, 400);
  if (text.length > max) throw new AppError(`${label} is too long.`, 400);
  return text;
}

export async function placeBuyerAdvert(req, res, next) {
  try {
    await premiumBuyer(req, "buyer_place_advert");
    const vendorId = req.body?.vendorId;
    if (!mongoose.isValidObjectId(vendorId)) {
      throw new AppError("Choose a vendor.", 400);
    }
    const headline = cleanText(req.body?.headline, 80, "A headline");
    const blurb = typeof req.body?.blurb === "string" ? req.body.blurb.trim() : "";
    if (blurb.length > 280) throw new AppError("The blurb is too long.", 400);
    const imageUrl = typeof req.body?.imageUrl === "string" ? req.body.imageUrl.trim() : "";
    if (!imageUrl) throw new AppError("Choose a photo from that vendor.", 400);

    const hidden = await User.exists({
      _id: vendorId,
      $or: [{ hiddenFromSearch: true }, { isBlocked: true }],
    });
    if (hidden) throw new AppError("That vendor is not on the Hub.", 404);

    const [store, products] = await Promise.all([
      Store.findOne({ vendorId }).select("gallery").lean(),
      Product.find({ vendorId }).select("mainImageUrl thumbnailUrls").lean(),
    ]);
    if (!store) throw new AppError("That vendor is not on the Hub.", 404);
    const allowed = new Set(store.gallery || []);
    for (const product of products) {
      if (product.mainImageUrl) allowed.add(product.mainImageUrl);
      for (const url of product.thumbnailUrls || []) if (url) allowed.add(url);
    }
    if (!allowed.has(imageUrl)) {
      throw new AppError("Use a photo already on that vendor's store.", 400);
    }

    const now = new Date();
    const [vendorLive, pairLive] = await Promise.all([
      HubAdvert.countDocuments({
        vendorId,
        status: "active",
        endsAt: { $gt: now },
      }),
      HubAdvert.countDocuments({
        vendorId,
        placedByBuyerId: req.actor.id,
        status: "active",
        endsAt: { $gt: now },
      }),
    ]);
    if (vendorLive >= HUB_MAX_ACTIVE_ADVERTS_PER_VENDOR) {
      throw new AppError("That vendor already has the maximum live adverts.", 400);
    }
    if (pairLive >= 1) {
      throw new AppError("You already have a live advert for this vendor.", 400);
    }

    const advert = await HubAdvert.create({
      vendorId,
      placedByBuyerId: req.actor.id,
      imageUrl,
      headline,
      blurb,
      endsAt: new Date(now.getTime() + HUB_ADVERT_DAYS * 24 * 3600 * 1000),
      costKobo: 0,
      enterpriseFree: false,
      pinned: true,
    });
    res.status(201).json({
      success: true,
      data: {
        id: String(advert._id),
        endsAt: advert.endsAt,
        // Null until BUYER_ADVERT_COMMISSION_KOBO is set. No figure is shown.
        commissionKobo: BUYER_ADVERT_COMMISSION_KOBO,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function boostAdvert(req, res, next) {
  try {
    await premiumBuyer(req, "buyer_boost_advert");
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw new AppError("Advert not found.", 404);
    }
    const advert = await HubAdvert.findOne({
      _id: req.params.id,
      status: "active",
      endsAt: { $gt: new Date() },
    });
    if (!advert) throw new AppError("Advert not found.", 404);
    const existing = await HubBroadcast.findOne({
      advertId: advert._id,
      status: { $in: ["draft", "queued", "sent"] },
    })
      .select("_id")
      .lean();
    if (existing) {
      return res.json({
        success: true,
        data: { id: String(existing._id), status: "queued" },
      });
    }
    const broadcast = await HubBroadcast.create({
      vendorId: advert.vendorId,
      message: advert.headline.slice(0, 280),
      imageUrl: advert.imageUrl,
      advertId: advert._id,
      status: "queued",
      costKobo: 0,
    });
    advert.boosted = true;
    await advert.save();
    res.status(201).json({
      success: true,
      data: { id: String(broadcast._id), status: "queued" },
    });
  } catch (err) {
    next(err);
  }
}

export async function createBuyerBroadcast(req, res, next) {
  try {
    await premiumBuyer(req, "buyer_broadcast");
    const message = cleanText(req.body?.message, 280, "A message");
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await BuyerBroadcast.countDocuments({
      buyerId: req.actor.id,
      createdAt: { $gte: since },
    });
    if (recent >= 5) throw new AppError("Slow down — five broadcasts an hour.", 429);

    const referred = await Buyer.find({ referredByBuyerId: req.actor.id })
      .select("_id")
      .lean();
    const live = referred.length
      ? await PlatformSubscription.find({
          ownerId: { $in: referred.map((row) => row._id) },
          ownerType: "buyer",
          plan: "buyer_premium",
          status: { $in: LIVE },
          currentPeriodEnd: { $gt: new Date() },
        })
          .select("ownerId")
          .lean()
      : [];
    const row = await BuyerBroadcast.create({
      buyerId: req.actor.id,
      message,
      audienceCount: live.length,
    });
    res.status(201).json({
      success: true,
      data: {
        id: String(row._id),
        audienceCount: live.length,
        status: "queued",
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function updateBroadcastPrefs(req, res, next) {
  try {
    if (req.actor?.type !== "buyer") {
      throw new AppError("Sign in as a buyer.", 401);
    }
    const tier = await resolveTier(req.actor);
    const promoEnabled = Boolean(req.body?.promoEnabled);
    const update = { "notificationPrefs.promoEnabled": promoEnabled };
    if (Array.isArray(req.body?.promoSectors)) {
      if (tier !== "buyer_premium") {
        throw new AppError("Choosing categories is part of Buyer Premium.", 403, {
          code: "upgrade_required",
          capability: "buyer_broadcast",
        });
      }
      update["notificationPrefs.promoSectors"] = req.body.promoSectors
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 12);
    }
    await Buyer.updateOne({ _id: req.actor.id }, { $set: update });
    const buyer = await Buyer.findById(req.actor.id)
      .select("notificationPrefs")
      .lean();
    res.json({
      success: true,
      data: {
        promoEnabled: Boolean(buyer?.notificationPrefs?.promoEnabled),
        promoSectors: buyer?.notificationPrefs?.promoSectors || [],
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function addFavourite(req, res, next) {
  try {
    await premiumBuyer(req, "favourite_vendor");
    const vendorId = req.body?.vendorId;
    if (!mongoose.isValidObjectId(vendorId)) {
      throw new AppError("Choose a vendor.", 400);
    }
    const store = await Store.exists({ vendorId });
    if (!store) throw new AppError("That vendor is not on the Hub.", 404);
    try {
      await FavouriteVendor.create({ buyerId: req.actor.id, vendorId });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    res.status(201).json({ success: true, data: { vendorId: String(vendorId) } });
  } catch (err) {
    next(err);
  }
}

export async function removeFavourite(req, res, next) {
  try {
    await premiumBuyer(req, "favourite_vendor");
    if (!mongoose.isValidObjectId(req.params.vendorId)) {
      throw new AppError("Choose a vendor.", 400);
    }
    await FavouriteVendor.deleteOne({
      buyerId: req.actor.id,
      vendorId: req.params.vendorId,
    });
    res.json({ success: true, data: { vendorId: String(req.params.vendorId) } });
  } catch (err) {
    next(err);
  }
}
