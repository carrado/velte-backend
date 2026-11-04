import { Router } from "express";

import { resolveActor } from "../middleware/resolveActor.js";
import { asBuyerAudience } from "../middleware/buyerAudience.js";
import { verifyAuth } from "../middleware/auth.js";
import {
  createReview,
  createValidation,
  finops,
  listCommunity,
  listSavedSearches,
  listVendorReviews,
  openDispute,
  postCommunity,
  replyToReview,
  reportCommunity,
  saveSearch,
} from "../controllers/trust/trust.controller.js";

const router = Router();

router.get("/reviews/:vendorId", listVendorReviews);
router.post("/reviews", resolveActor, asBuyerAudience, createReview);
router.post("/reviews/:id/reply", verifyAuth, replyToReview);
router.post("/validations", resolveActor, asBuyerAudience, createValidation);
router.post("/disputes", resolveActor, openDispute);
router.get("/saved-searches", resolveActor, listSavedSearches);
router.post("/saved-searches", resolveActor, saveSearch);
router.get("/community", resolveActor, listCommunity);
router.post("/community", resolveActor, asBuyerAudience, postCommunity);
router.post("/community/:id/report", resolveActor, asBuyerAudience, reportCommunity);
router.get("/finops", verifyAuth, finops);

export default router;
