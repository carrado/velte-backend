import express from "express";
import rateLimit from "express-rate-limit";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";
import {
  createRequest,
  getMyRequests,
  getRequest,
  cancelRequest,
  getResponses,
} from "../controllers/buyerRequests/buyerRequests.controller.js";

const router = express.Router();

router.use(verifyBuyerAuth);

// Spec §52 — "request rate limiting," kept configurable via a named
// constant rather than a magic number, same pattern as wallet.routes.js's
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

router.post("/", createRequestLimiter, createRequest);
router.get("/my", getMyRequests);
router.get("/:id", getRequest);
router.get("/:id/responses", getResponses);
router.patch("/:id/cancel", cancelRequest);

export default router;
