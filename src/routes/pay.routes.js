import { Router } from "express";
import rateLimit from "express-rate-limit";
import { param, query, body } from "express-validator";
import { validate } from "../middleware/validate.js";
import { getPayLink, initializePayLink } from "../controllers/orders/payPage.controller.js";

const router = Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────
// Public, unauthenticated endpoints — keep them tighter than the global limiter.
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please slow down." },
});

const initLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many payment attempts. Please wait a moment." },
});

const linkIdParam = param("linkId")
  .trim()
  .notEmpty()
  .matches(/^[a-zA-Z0-9_-]+$/)
  .withMessage("Invalid payment link id");

// ── Routes ────────────────────────────────────────────────────────────────────

// Public: details to render the pay page (payee, amount, order summary).
router.get(
  "/:linkId",
  readLimiter,
  linkIdParam,
  query("ref").optional().isString().isLength({ max: 100 }),
  validate,
  getPayLink,
);

// Public: start a Paystack checkout for this link (optionally tied to an order).
router.post(
  "/:linkId/initialize",
  initLimiter,
  linkIdParam,
  body("ref").optional().isString().isLength({ max: 100 }),
  body("email").optional().isEmail().withMessage("Invalid email"),
  body("amount").optional().isFloat({ min: 1 }).withMessage("amount must be a positive number"),
  body("customerName").optional().isString().isLength({ max: 120 }),
  body("customerPhone").optional().isString().isLength({ max: 30 }),
  validate,
  initializePayLink,
);

export default router;
