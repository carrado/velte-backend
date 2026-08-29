import express from "express";
import rateLimit from "express-rate-limit";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";
import {
  getMyPlan,
  initCheckout,
  listPlans,
} from "../controllers/buyerBilling/buyerBilling.controller.js";

const router = express.Router();

// Public: a pricing page has to show prices before anyone signs in, and this
// returns nothing that isn't meant to be published.
router.get("/plans", listPlans);

// Everything below needs a real account — there is nobody to upgrade
// otherwise, and a plan is account data.
router.use(verifyBuyerAuth);

router.get("/me", getMyPlan);

// Opening a Paystack transaction is a real outbound API call, so it gets its
// own limiter — same pattern as wallet.routes.js's initLimiter. Generous
// enough that a buyer retrying a failed card isn't punished, tight enough
// that a loop can't burn our Paystack rate limit.
const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many payment attempts. Please wait a few minutes.",
  },
});

router.post("/checkout", checkoutLimiter, initCheckout);

export default router;
