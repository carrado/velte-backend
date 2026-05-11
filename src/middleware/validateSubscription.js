// src/middleware/validateSubscription.js
// express-validator chains for subscription endpoints.
// Follows the same pattern as src/middleware/validate.js.

import { body, validationResult } from "express-validator";
import { AppError } from "./errorHandler.js";

function validate(req, _res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map((e) => e.msg).join(". ");
    return next(new AppError(messages, 400));
  }
  next();
}

export const validateInitialize = [
  body("plan")
    .optional()
    .isIn(["monthly", "annual"])
    .withMessage("plan must be 'monthly' or 'annual'"),
  validate,
];

export const validateVerify = [
  body("reference")
    .trim()
    .notEmpty()
    .withMessage("Payment reference is required")
    .isLength({ max: 200 })
    .withMessage("Reference is too long"),
  validate,
];