import express from "express";
import rateLimit from "express-rate-limit";
import {
  requestOtp,
  verifyOtp,
  me,
  updateMe,
  logout,
} from "../controllers/buyerAuth/buyerAuth.controller.js";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";

const router = express.Router();

// Tight limit specifically on OTP requests — this is the one endpoint that
// spends real money per call (one SMS) and could otherwise be used to spam
// an arbitrary phone number with codes. Mirrors wallet.routes.js's
// initLimiter pattern.
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many code requests. Please wait before trying again.",
  },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please wait before trying again.",
  },
});

// No POST /login here — buyer login is handled by the unified
// POST /auth/login (auth.js), which checks vendor first and falls back to
// this Buyer collection. See buyerAuth.controller.js's own comment.
router.post("/request-otp", otpRequestLimiter, requestOtp);
router.post("/verify-otp", otpVerifyLimiter, verifyOtp);
router.get("/me", verifyBuyerAuth, me);
router.patch("/me", verifyBuyerAuth, updateMe);
router.post("/logout", logout);

export default router;
