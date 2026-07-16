import express from "express";
import { chargeLead } from "../controllers/search/search.controller.js";

const router = express.Router();

// /products, /stores, /log moved to the standalone staffly-ai-backend
// service — see its README. Only /lead stays here (wallet billing).
// Public — called directly from the buyer's browser (via sendBeacon) when
// they click "Chat on WhatsApp".
router.post("/lead", chargeLead);

export default router;
