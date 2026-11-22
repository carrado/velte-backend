import express from "express";

import { resolveActor } from "../middleware/resolveActor.js";
import { asBuyerAudience } from "../middleware/buyerAudience.js";
import {
  listGigs,
  getGigDetails,
  createGig,
  applyForGig,
  listMyBuyerGigs,
  submitGigWork,
  assignGig,
  approveGigWork,
} from "../controllers/hub/gigs.controller.js";

const router = express.Router();

// Public / Buyer browsing
router.get("/", resolveActor, listGigs);
router.get("/mine", resolveActor, asBuyerAudience, listMyBuyerGigs);
router.get("/:id", resolveActor, getGigDetails);

// Actions
router.post("/", resolveActor, createGig);
router.post("/:id/apply", resolveActor, asBuyerAudience, applyForGig);
router.post("/:id/submit", resolveActor, asBuyerAudience, submitGigWork);
router.post("/:id/assign", resolveActor, assignGig);
router.post("/:id/approve", resolveActor, approveGigWork);

export default router;

