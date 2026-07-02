import express from "express";
import rateLimit from "express-rate-limit";
import { verifyAuth } from "../middleware/auth.js";
import {
  getWallet,
  initializeTopup,
  verifyTopup,
  setFundingMethod,
  requestDva,
  getTransactions,
} from "../controllers/wallet/wallet.controller.js";

const router = express.Router();

router.use(verifyAuth);

// Tight on checkout init — prevents abuse / spam, mirrors the old subscription pattern.
const initLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many top-up attempts. Try again in an hour." },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many verification attempts. Please wait." },
});

router.get("/", getWallet);
router.post("/topup/initialize", initLimiter, initializeTopup);
router.post("/topup/verify", verifyLimiter, verifyTopup);
router.put("/funding-method", setFundingMethod);
router.post("/dva", initLimiter, requestDva);
router.get("/transactions", getTransactions);

export default router;
