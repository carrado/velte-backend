// src/middleware/validate.js
import { validationResult, body, param } from "express-validator";
import { AppError } from "./errorHandler.js";

/**
 * Runs after express-validator chains.
 * Collects all errors and throws a single AppError(400) if any exist.
 */
export function validate(req, _res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors
      .array()
      .map((e) => e.msg)
      .join(". ");
    return next(new AppError(messages, 400));
  }
  next();
}

// ── Validation rule sets ──────────────────────────────────────────────────────

export const validateMetaConnect = [
  body("accessToken")
    .trim()
    .notEmpty()
    .withMessage("Meta accessToken is required (send response.authResponse.accessToken from the FB JS SDK).")
    .isLength({ max: 2000 })
    .withMessage("accessToken is too long"),
  validate,
];

export const validateWABAConfigure = [
  body("wabaId")
    .trim()
    .notEmpty()
    .withMessage("WABA ID is required")
    .isLength({ max: 100 })
    .withMessage("WABA ID is too long")
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage("WABA ID contains invalid characters"),
  validate,
];

export const validateSelectNumber = [
  body("numberId")
    .trim()
    .notEmpty()
    .withMessage("Number ID is required")
    .isLength({ max: 100 })
    .withMessage("Number ID is too long")
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage("Number ID contains invalid characters"),
  validate,
];

export const validateAIConfig = [
  body("enabled")
    .isBoolean()
    .withMessage("enabled must be a boolean"),

  body("greetingMessage")
    .trim()
    .notEmpty()
    .withMessage("Greeting message is required")
    .isLength({ max: 1000 })
    .withMessage("Greeting message cannot exceed 1000 characters"),

  body("businessTone")
    .isIn(["formal", "professional", "casual"])
    .withMessage("businessTone must be one of: formal, professional, casual"),

  body("productCatalogSync")
    .isBoolean()
    .withMessage("productCatalogSync must be a boolean"),

  validate,
];

export const validateWebhook = [
  // Verify Meta's hub.verify_token matches our secret
  param("mode")
    .optional()
    .isString(),
  param("verify_token")
    .optional()
    .isString(),
  validate,
];