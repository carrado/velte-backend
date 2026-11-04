import express from "express";
import rateLimit from "express-rate-limit";
import { verifyAuth } from "../middleware/auth.js";
import {
  getBanks,
  getPayoutAccount,
  resolveAccount,
  savePayoutAccount,
  removePayoutAccount,
} from "../controllers/payouts/payout.controller.js";

const router = express.Router();

router.use(verifyAuth);

// Saving hits Paystack's resolve endpoint with a number the caller chose, so
// an unbounded route is a free bank-account enumerator run on Velte's key.
// Tight on purpose: setting a payout account is a once-or-twice-ever action.
const saveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please try again in an hour.",
  },
});

// Tighter than saving on purpose — see the controller. A vendor correcting a
// typo makes a handful of these; nothing legitimate makes dozens.
const resolveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many lookups. Please try again in a little while.",
  },
});

router.get("/banks", getBanks);
router.get("/", getPayoutAccount);
router.post("/resolve", resolveLimiter, resolveAccount);
router.post("/", saveLimiter, savePayoutAccount);
router.delete("/", removePayoutAccount);

export default router;
