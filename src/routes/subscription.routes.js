// src/routes/subscription.routes.js
//
// Subscription tiers are retired. Only the Paystack webhook survives, since its
// URL is registered with Paystack — see subscription.controller.js.
//   POST /api/subscription/webhook   ← public, signature-verified, raw body

import { Router } from "express";
import express from "express";
import { handleWebhook } from "../controllers/subscriptions/subscription.controller.js";

const router = Router();

// MUST use express.raw() so we can verify the HMAC-SHA512 signature against the
// raw request body. If express.json() runs first it consumes the stream and the
// signature check fails.
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  handleWebhook,
);

export default router;
