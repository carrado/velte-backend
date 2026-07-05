import express from "express";
import {
  searchProducts,
  searchStores,
  logSearch,
} from "../controllers/search/search.controller.js";

const router = express.Router();

// Public — called by the frontend's /api/search route, no session required.
router.post("/products", searchProducts);
router.post("/stores", searchStores);
router.post("/log", logSearch);

export default router;
