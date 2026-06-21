import { Router } from "express";
import rateLimit from "express-rate-limit";
import { param, body } from "express-validator";
import { validate } from "../middleware/validate.js";
import { trackOrder } from "../controllers/orders/trackOrder.controller.js";

const router = Router();

// Public, unauthenticated endpoint — tighter than the global limiter, and because
// the key is a short code it also throttles brute-force key guessing.
const trackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please wait a moment." },
});

// Public: validate the key and return the order's tracking details.
router.post(
  "/:token",
  trackLimiter,
  param("token")
    .trim()
    .notEmpty()
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage("Invalid tracking link"),
  body("key").isString().trim().isLength({ min: 1, max: 32 }).withMessage("Tracking key is required"),
  validate,
  trackOrder,
);

export default router;
