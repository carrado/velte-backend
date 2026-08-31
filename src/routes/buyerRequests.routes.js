import express from "express";
import rateLimit from "express-rate-limit";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";
import {
  createRequest,
  listMyRequests,
} from "../controllers/buyerRequests/buyerRequests.controller.js";

const router = express.Router();

// verifyBuyerAuth (2026-08-29, per explicit product direction): posting a
// Buyer Request now requires a real account. It previously also accepted a
// `phoneToken` — a bare proof of one number from someone with no account —
// on the reasoning that reaching out was the one thing an anonymous buyer
// most needed to be able to do.
//
// That reasoning is overridden deliberately, and the trade is real: fewer
// requests will be posted. What is bought is that every request has an
// account behind it — reachable later, holding its own history, and
// answerable for what it asked for. Sign up, THEN prove a number.
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

// GET /mine (2026-08-30) — the buyer's own list, which the 2026-08-18 note
// here ruled out on the grounds that buyers had no account to read an inbox
// from. They have had one since 2026-08-29, and posting a request now
// REQUIRES one, so every request has an owner to show it to. A vendor's own
// view of a request still lives entirely under vendorBuyerRequests.routes.js
// — this one never leaves the caller's own buyerId.
//
// Before "/" so the literal segment can't be swallowed by a future
// parameterised route added above it.
router.get("/mine", listMyRequests);
router.post("/", createRequestLimiter, createRequest);

export default router;
