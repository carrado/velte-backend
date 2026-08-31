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
// reopened (see Buyer.model.js). Google is the ONLY way in — phone+OTP has
// never issued a session, and as of 2026-08-29 it cannot even be reached
// without one.
// attachBuyerIfPresent so signing in with Google can LINK to a session the
// buyer already has, instead of silently starting a second account — see
// the controller's resolution order.
router.post(
  "/firebase",
  firebaseSignInLimiter,
  attachBuyerIfPresent,
  firebaseSignIn,
);
// verifyBuyerAuth, not attachBuyerIfPresent (2026-08-29, per explicit product
// direction). Proving a phone is no longer something a stranger can do: you
// sign up with Google FIRST, and only then attach a number. The anonymous
// half of both handlers is gone with it, because the `phoneToken` it minted
// was only ever accepted by POST /buyer-requests, which now requires a real
// account too.
//
// This also removes the last way to spend an SMS without an account —
// previously anyone could burn one code per number, rate-limited but free.
router.post("/request-otp", otpRequestLimiter, verifyBuyerAuth, requestOtp);
router.post("/verify-otp", otpVerifyLimiter, verifyBuyerAuth, verifyOtp);
router.get("/me", verifyBuyerAuth, me);
router.post("/logout", logout);

export default router;
