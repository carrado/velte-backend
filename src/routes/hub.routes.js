import express from "express";

import { resolveActor } from "../middleware/resolveActor.js";
import { asBuyerAudience } from "../middleware/buyerAudience.js";
import { requireEntitlement } from "../services/tier.service.js";
import {
  getHubContext,
  getHubHome,
  getHubVendors,
  createAdvert,
  createListingBoost,
  listMyAdverts,
  trackAdvertEngagement,
  listMyListingBoosts,
  cancelListingBoost,
  cancelAdvert,
  createBroadcast,
  listMyBroadcasts,
  cancelBroadcast,
  consumeAiPosterSlot,
  refundAiPosterSlot,
  getHubAnalytics,
} from "../controllers/hub/hub.controller.js";
import {
  addFavourite,
  boostAdvert,
  createBuyerBroadcast,
  placeBuyerAdvert,
  removeFavourite,
  updateBroadcastPrefs,
} from "../controllers/hub/buyerHub.controller.js";

const router = express.Router();

// Vendor dashboard publish UI's single context call (tier, prices, caps,
// counts, wallet balance). No entitlement gate — both tiers may view; the
// create endpoints below gate.
router.get("/context", resolveActor, getHubContext);

// Hub home: featured vendors and the timeline for a signed-up buyer or a
// vendor. A vendor also gets their store and performance. Guests are
// refused in the controller.
router.get("/home", resolveActor, asBuyerAudience, getHubHome);

// Full buyer vendor directory — every discoverable store with Hub badges.
router.get("/vendors", resolveActor, asBuyerAudience, getHubVendors);

// Vendor-owned publish side. requireEntitlement refuses with
// 403 { code: "upgrade_required", capability } for the wrong tier — the same
// pattern as phone_required, so the frontend opens the right upgrade sheet.
// AI advert poster daily quota (Lagos day). No entitlement gate beyond
// vendor session — Basic gets 2, Enterprise 5. The BFF consumes before
// OpenAI and refunds on generation failure.
router.post("/ai-poster/consume", resolveActor, consumeAiPosterSlot);
router.post("/ai-poster/refund", resolveActor, refundAiPosterSlot);

router.get(
  "/adverts/mine",
  resolveActor,
  requireEntitlement("place_advert"),
  listMyAdverts,
);
router.post("/adverts/:id/track", resolveActor, trackAdvertEngagement);
router.post(
  "/adverts",
  resolveActor,
  requireEntitlement("place_advert"),
  createAdvert,
);
router.get(
  "/boosts",
  resolveActor,
  requireEntitlement("boost_advert"),
  listMyListingBoosts,
);
router.post(
  "/boosts",
  resolveActor,
  requireEntitlement("boost_advert"),
  createListingBoost,
);
router.post(
  "/boosts/:id/cancel",
  resolveActor,
  requireEntitlement("boost_advert"),
  cancelListingBoost,
);
router.post(
  "/adverts/:id/cancel",
  resolveActor,
  requireEntitlement("place_advert"),
  cancelAdvert,
);
router.get(
  "/broadcasts/mine",
  resolveActor,
  requireEntitlement("vendor_broadcast"),
  listMyBroadcasts,
);
router.post(
  "/broadcasts",
  resolveActor,
  requireEntitlement("vendor_broadcast"),
  createBroadcast,
);
router.post(
  "/broadcasts/:id/cancel",
  resolveActor,
  requireEntitlement("vendor_broadcast"),
  cancelBroadcast,
);

// Enterprise Hub Exclusives: Analytics & Insights
router.get("/analytics", resolveActor, requireEntitlement("analytics_insights"), getHubAnalytics);

// Buyer actions on the Hub. asBuyerAudience keeps a linked vendor session
// on the buyer tier. Premium is enforced in the controller.
router.post("/buyer-adverts", resolveActor, asBuyerAudience, placeBuyerAdvert);
router.post("/adverts/:id/boost", resolveActor, asBuyerAudience, boostAdvert);
router.post("/buyer-broadcasts", resolveActor, asBuyerAudience, createBuyerBroadcast);
router.patch("/broadcast-prefs", resolveActor, asBuyerAudience, updateBroadcastPrefs);
router.post("/favourites", resolveActor, asBuyerAudience, addFavourite);
router.delete("/favourites/:vendorId", resolveActor, asBuyerAudience, removeFavourite);

export default router;
