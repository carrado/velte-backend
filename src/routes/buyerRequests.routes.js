import express from "express";
import rateLimit from "express-rate-limit";
import { resolveActor } from "../middleware/resolveActor.js";
import {
  createRequest,
  listMyRequests,
} from "../controllers/buyerRequests/buyerRequests.controller.js";

const router = express.Router();

// EITHER session, not buyer-only (2026-09-27, explicit product direction).
//
// Was `verifyBuyerAuth` alone (2026-08-29), which made posting a Buyer
// Request buyer-only — and that was right while the only person who could
// want one was a buyer. A VENDOR buys things other than what they sell, and
// /chat is where they do it: a vendor signed into /chat with their vendor
// cookie was told to "sign in first", while already being signed in.
//
// `resolveActor` is the same either-session resolver credits.routes.js and
// notifications.routes.js already mount, and it sets `req.actor = { id,
// type }`. Its own linked-identity rule matters here too: a buyer carrying
// `Buyer.linkedVendorId` resolves AS the vendor, so a vendor who signed into
// /chat with Google on their own vendor email posts as themselves rather
// than as the shadow buyer account Firebase created.
//
// The 2026-08-29 decision this replaces is NOT reversed: every request still
// has a real, verified ACCOUNT behind it (an email-verified User or a
// Firebase Buyer). What changed is that a vendor account now qualifies. The
// `phoneToken` path — a bare proof of a number with no account at all —
// stays gone.
//
// Still 401s an anonymous caller: resolveActor never fails a request (it
// leaves `req.actor` null), so the guard is explicit and lives here, once,
// rather than in each controller.
router.use(resolveActor, (req, res, next) => {
  if (!req.actor) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  next();
});

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
