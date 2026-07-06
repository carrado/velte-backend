import express from "express";
import {
  searchProducts,
  searchStores,
  logSearch,
  chargeLead,
} from "../controllers/search/search.controller.js";

const router = express.Router();

// Public — called by the frontend's /api/search route, no session required.
router.post("/products", searchProducts);
router.post("/stores", searchStores);
router.post("/log", logSearch);
// Public — called directly from the buyer's browser (via sendBeacon) when
// they click "Chat on WhatsApp", not from the /api/search route above.
router.post("/lead", chargeLead);

export default router;
