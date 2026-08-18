import express from "express";
import rateLimit from "express-rate-limit";
import { verifyAuth } from "../middleware/auth.js";
import {
  listMatchedRequests,
  getRequestDetail,
  decideOnRequest,
} from "../controllers/buyerRequests/vendorBuyerRequests.controller.js";

const router = express.Router();

router.use(verifyAuth);

const decisionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many responses sent. Please wait before responding again.",
  },
});

router.get("/", listMatchedRequests);
router.get("/:id", getRequestDetail);
router.post("/:id/decision", decisionLimiter, decideOnRequest);

export default router;
