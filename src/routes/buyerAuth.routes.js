import express from "express";
import rateLimit from "express-rate-limit";
import {
  requestOtp,
  verifyOtp,
  me,
  logout,
} from "../controllers/buyerAuth/buyerAuth.controller.js";
import { firebaseSignIn } from "../controllers/buyerAuth/firebaseAuth.controller.js";
import {
  verifyBuyerAuth,
  attachBuyerIfPresent,
} from "../middleware/buyerAuth.js";

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

// Firebase sign-in shares the OTP-verify limiter's shape but gets its own
// instance: both are "attempt to establish a session" endpoints worth
// rate-limiting, but a buyer retrying a Google sign-in shouldn't burn
// through the budget for someone else's phone verification, or vice versa.
const firebaseSignInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many sign-in attempts. Please wait before trying again.",
  },
});

// 2026-08-18's "buyers never log in" note no longer holds: buyers have real
// accounts as of 2026-08-26 so their conversation history can be listed and
// reopened (see Buyer.model.js). Phone+OTP stays exactly as it was — it is
// still the path that proves a number for Buyer Requests, and now also a
// second way into the same account.
// attachBuyerIfPresent so signing in with Google can LINK to a session the
// buyer already has, instead of silently starting a second account — see
// the controller's resolution order.
router.post(
  "/firebase",
  firebaseSignInLimiter,
  attachBuyerIfPresent,
  firebaseSignIn,
);
// attachBuyerIfPresent, not verifyBuyerAuth: both endpoints must keep
// working for a buyer with no account (verifying a phone is how one is
// created), while behaving differently for a signed-in buyer ATTACHING a
// number to an account they already have — see the controller's own split.
router.post(
  "/request-otp",
  otpRequestLimiter,
  attachBuyerIfPresent,
  requestOtp,
);
router.post("/verify-otp", otpVerifyLimiter, attachBuyerIfPresent, verifyOtp);
router.get("/me", verifyBuyerAuth, me);
router.post("/logout", logout);

export default router;
