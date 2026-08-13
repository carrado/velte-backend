import express from "express";
import rateLimit from "express-rate-limit";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";
import { toggleSaved, getMySaved } from "../controllers/buyerSaved/buyerSaved.controller.js";

const router = express.Router();

router.use(verifyBuyerAuth);

// A vendor follow now pushes a real notification to that vendor (see
// toggleSaved's own comment) — this caps how fast a single buyer can
// follow/unfollow/re-follow the same (or different) vendors, so that new
// side effect can't be used to spam a vendor with notifications. Generous
// on purpose: legitimate browsing can mean saving many items in a short
// session, this is only meant to catch abuse-speed tapping.
const toggleLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many changes. Please wait a moment before trying again.",
  },
});

router.post("/toggle", toggleLimiter, toggleSaved);
router.get("/my", getMySaved);

export default router;
