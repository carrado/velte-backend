// src/routes/aiSetup.routes.js
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { verifyAuth } from "../middleware/auth.js";
import {
  validateMetaConnect,
  validateSelectNumber,
  validateAIConfig,
  validateWhatsAppProfile,
} from "../middleware/validate.js";
import {
  getStatus,
  configureWABA,
  getNumbers,
  selectNumber,
  updateConfig,
  activateAI,
  disconnectAI,
} from "../controllers/ai/setUp.controller.js";
import {
  getWhatsAppProfile,
  saveWhatsAppProfile,
} from "../controllers/ai/whatsappProfile.controller.js";

const router = Router();

// ── Endpoint-specific rate limiters ───────────────────────────────────────────

/** Tight limit on Meta OAuth calls — these are expensive and rarely needed. */
const metaAuthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,
  message: { success: false, message: "Too many Meta connection attempts. Please try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Moderate limit on number fetches — users may click "Refresh" a few times. */
const numbersLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,    // 5 minutes
  max: 20,
  message: { success: false, message: "Too many number fetch requests. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Tight limit on activation — should only happen once per setup. */
const activateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 5,
  message: { success: false, message: "Too many activation attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});


// ── Protected routes — all require a valid JWT ─────────────────────────────────

router.use(verifyAuth);

/**
 * GET /api/ai-setup/status
 * Returns the current setup state for the authenticated user.
 * Used by the frontend on page load to restore wizard progress.
 */
router.get("/status", getStatus);

/**
 * POST /api/ai-setup/waba/configure
 * Body: { wabaId: string }
 * Stores the WABA ID and fetches available phone numbers from Meta.
 */
router.post("/waba/configure", metaAuthLimiter, validateMetaConnect, configureWABA);

/**
 * GET /api/ai-setup/numbers
 * Fetches a fresh list of WhatsApp numbers from Meta for the stored WABA.
 */
router.get("/numbers", numbersLimiter, getNumbers);

/**
 * POST /api/ai-setup/numbers/select
 * Body: { numberId: string }
 * Records which number the AI will manage.
 */
router.post("/numbers/select", validateSelectNumber, selectNumber);

/**
 * PUT /api/ai-setup/config
 * Body: AIConfig object
 * Saves AI configuration (can also be called post-setup to update settings).
 */
router.put("/config", validateAIConfig, updateConfig);

/**
 * GET /api/ai-setup/whatsapp-profile
 * Loads Meta business profile + saved featured products.
 */
router.get("/whatsapp-profile", getWhatsAppProfile);

/**
 * PUT /api/ai-setup/whatsapp-profile
 * Updates Meta business profile, user services, and catalog products (max 3).
 */
router.put("/whatsapp-profile", validateWhatsAppProfile, saveWhatsAppProfile);

/**
 * POST /api/ai-setup/activate
 * Registers the Meta webhook and marks the integration as live.
 */
router.post("/activate", activateLimiter, activateAI);

/**
 * DELETE /api/ai-setup/disconnect
 * Resets the entire integration for the user.
 */
router.delete("/disconnect", disconnectAI);

export default router;