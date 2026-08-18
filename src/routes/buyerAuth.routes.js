import express from "express";
import rateLimit from "express-rate-limit";
import {
  requestOtp,
  verifyOtp,
  me,
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

// No login route here — buyers never log in, this is a one-time
// phone-verification step, not an account (2026-08-18, see
// buyerAuth.controller.js's own comment).
router.post("/request-otp", otpRequestLimiter, requestOtp);
router.post("/verify-otp", otpVerifyLimiter, verifyOtp);
router.get("/me", verifyBuyerAuth, me);
router.post("/logout", logout);

export default router;
