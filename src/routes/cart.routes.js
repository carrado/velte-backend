import express from "express";
import rateLimit from "express-rate-limit";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";
import {
  validateCartAdd,
  quoteCart,
  checkoutCart,
  verifyCartCheckout,
  listBuyerOrders,
  getBuyerOrder,
  markOrderReceived,
  disputeOrder,
} from "../controllers/cart/cart.controller.js";

const router = express.Router();

router.use(verifyBuyerAuth);

const addLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many cart updates. Please wait a moment.",
  },
});

router.post("/validate-add", addLimiter, validateCartAdd);
router.post("/quote", quoteCart);
router.post("/checkout", checkoutCart);
router.post("/verify", verifyCartCheckout);
router.get("/orders", listBuyerOrders);
router.get("/orders/:id", getBuyerOrder);
router.post("/orders/:id/received", markOrderReceived);
router.post("/orders/:id/dispute", disputeOrder);

export default router;
