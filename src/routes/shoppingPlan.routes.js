import express from "express";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";
import {
  createPlan,
  listMyPlans,
  getPlan,
  replaceItem,
} from "../controllers/shoppingPlan/shoppingPlan.controller.js";

const router = express.Router();

// Buyer session only — see ShoppingPlan.model.js on why there's no
// vendor-side use case here, unlike BuyerRequest.
router.use(verifyBuyerAuth);

router.post("/", createPlan);
router.get("/mine", listMyPlans);
router.get("/:id", getPlan);
router.patch("/:id/items/:itemId", replaceItem);

export default router;
