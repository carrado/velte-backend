import express from "express";
import rateLimit from "express-rate-limit";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";
import { createRequest } from "../controllers/buyerRequests/buyerRequests.controller.js";

const router = express.Router();

router.use(verifyBuyerAuth);

// Named constant, not a magic number — same pattern as wallet.routes.js's
// initLimiter.
const createRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests posted. Please wait before posting another.",
  },
});

// No GET/cancel routes here (2026-08-18) — buyers have no account/inbox to
// view or manage their own requests from anymore; posting one is the whole
// interaction. A vendor's own view of a request lives entirely under
// vendorBuyerRequests.routes.js instead.
router.post("/", createRequestLimiter, createRequest);

export default router;
