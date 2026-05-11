// src/routes/subscription.routes.js
//
// Matches the frontend service calls exactly:
//   GET  /api/subscription/status
//   POST /api/subscription/initialize
//   POST /api/subscription/verify
//   POST /api/subscription/webhook   ← public, signature-verified, raw body

import { Router } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import { verifyAuth } from "../middleware/auth.js";
import { validateInitialize, validateVerify } from "../middleware/validateSubscription.js";
import {
  getStatus,
  initializeSubscription,
  verifySubscription,
  handleWebhook,
} from "../controllers/subscriptions/subscription.controller.js";

const router = Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────

// Tight on checkout init — prevents abuse / spam
const initLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many checkout attempts. Try again in an hour." },
});

// Moderate on verify — user may close and reopen the popup
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many verification attempts. Please wait." },
});

// ── Webhook route ─────────────────────────────────────────────────────────────
// MUST come before router.use(verifyAuth) and MUST use express.raw() so we
// can verify the HMAC-SHA512 signature against the raw request body.
// If express.json() runs first it consumes the stream and signature check fails.

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  handleWebhook,
);

// ── Protected routes — require valid JWT cookie ───────────────────────────────

router.use(verifyAuth);

/**
 * GET /api/subscription/status
 * Returns the user's current subscription state.
 * Called on every dashboard load by TrialGate.
 */
router.get("/status", getStatus);

/**
 * POST /api/subscription/initialize
 * Body: { plan?: "monthly" | "annual" }
 * Creates a Paystack transaction and returns { authorization_url, reference }.
 */
router.post("/initialize", initLimiter, validateInitialize, initializeSubscription);

/**
 * POST /api/subscription/verify
 * Body: { reference: string }
 * Verifies payment with Paystack and activates subscription if successful.
 */
router.post("/verify", verifyLimiter, validateVerify, verifySubscription);

export default router;