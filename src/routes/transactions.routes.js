import express from "express";
import rateLimit from "express-rate-limit";
import { body, param, query } from "express-validator";
import { validate } from "../middleware/validate.js";
import { verifyAuth } from "../middleware/auth.js";
import {
  getBanks,
  resolveAccount,
  generatePaymentLink,
  deactivatePaymentLink,
  reactivatePaymentLink,
  deletePaymentLink,
  getTransactions,
  createTransaction,
} from "../controllers/transaction/transaction.controller.js";
import { initiateOrderRefund } from "../controllers/orders/orderRefund.controller.js";

const router = express.Router();

// ── Rate limiters (matching the ai-setup pattern) ─────────────────────────────
const resolveAccountLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  message: { success: false, message: "Too many resolve requests, slow down." },
});

const generateLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: {
    success: false,
    message: "Payment link limit reached. Try again later.",
  },
});

const paymentLinkActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: "Too many payment link actions. Try again later.",
  },
});

// 10 refund attempts per hour per IP — matches the Meta auth limiter pattern
const refundLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many refund requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const paymentLinkIdValidation = [
  param("id").isMongoId().withMessage("Invalid payment link id"),
];

// ── Validation chains ─────────────────────────────────────────────────────────
const generateLinkValidation = [
  body("bankCode").notEmpty().withMessage("bankCode is required"),
  body("accountNumber")
    .matches(/^\d{10}$/)
    .withMessage("accountNumber must be exactly 10 digits"),
  body("accountName").notEmpty().withMessage("accountName is required"),
  body("amount")
    .optional()
    .isFloat({ min: 1 })
    .withMessage("amount must be a positive number"),
  body("description")
    .optional()
    .isString()
    .isLength({ max: 200 })
    .withMessage("description must be at most 200 characters"),
];

const resolveAccountValidation = [
  query("accountNumber")
    .matches(/^\d{10}$/)
    .withMessage("accountNumber must be exactly 10 digits"),
  query("bankCode").notEmpty().withMessage("bankCode is required"),
];

const createTransactionValidation = [
  body("customerId").notEmpty().withMessage("customerId is required"),
  body("name").notEmpty().withMessage("name is required"),
  body("total")
    .isFloat({ min: 0 })
    .withMessage("total must be a non-negative number"),
  body("method")
    .isIn(["CC", "PayPal", "Bank"])
    .withMessage("method must be CC, PayPal, or Bank"),
  body("status")
    .optional()
    .isIn(["Complete", "Pending", "Canceled"])
    .withMessage("status must be Complete, Pending, or Canceled"),
];

// ── Validation chain for POST /order-refund ───────────────────────────────────
const validateOrderRefund = [
  body("orderId")
    .trim()
    .notEmpty()
    .withMessage("orderId is required.")
    .isString()
    .withMessage("orderId must be a string."),

  body("amount")
    .notEmpty()
    .withMessage("amount is required.")
    .isFloat({ min: 1, max: 10_000_000 })
    .withMessage("amount must be a positive number not exceeding ₦10,000,000."),

  body("reason")
    .optional()
    .trim()
    .isString()
    .withMessage("reason must be a string.")
    .isLength({ max: 200 })
    .withMessage("reason must not exceed 200 characters."),
];


// ── Routes ────────────────────────────────────────────────────────────────────

// Public-ish: banks list (still auth-gated so only app users can call it)
router.get("/banks", verifyAuth, getBanks);

// Account resolution
router.get(
  "/resolve-account",
  verifyAuth,
  resolveAccountLimiter,
  resolveAccountValidation,
  validate,
  resolveAccount,
);

// Generate payment link
router.post(
  "/payment-link",
  verifyAuth,
  generateLinkLimiter,
  generateLinkValidation,
  validate,
  generatePaymentLink,
);

router.patch(
  "/payment-link/:id/deactivate",
  verifyAuth,
  paymentLinkActionLimiter,
  paymentLinkIdValidation,
  validate,
  deactivatePaymentLink,
);

router.patch(
  "/payment-link/:id/reactivate",
  verifyAuth,
  paymentLinkActionLimiter,
  paymentLinkIdValidation,
  validate,
  reactivatePaymentLink,
);

router.delete(
  "/payment-link/:id",
  verifyAuth,
  paymentLinkActionLimiter,
  paymentLinkIdValidation,
  validate,
  deletePaymentLink,
);

// List transactions
router.get("/", verifyAuth, getTransactions);

// Create transaction (e.g. from webhook or manual entry)
router.post(
  "/",
  verifyAuth,
  createTransactionValidation,
  validate,
  createTransaction,
);


router.post(
  "/order-refund",
  refundLimiter,
  verifyAuth,
  validateOrderRefund,
  initiateOrderRefund,
);


export default router;