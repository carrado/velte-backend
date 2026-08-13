import express from "express";
import { subscribe, unsubscribe } from "../controllers/buyerPush/buyerPush.controller.js";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";

const router = express.Router();

router.post("/subscribe", verifyBuyerAuth, subscribe);
router.post("/unsubscribe", verifyBuyerAuth, unsubscribe);

export default router;
