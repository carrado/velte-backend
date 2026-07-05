import express from "express";
import { verifyAuth } from "../middleware/auth.js";
import {
  getMyStore,
  updateMyStore,
  connectCatalog,
  getPublicStore,
} from "../controllers/store/store.controller.js";

const router = express.Router();

// Public — powers the /store/:handle page, no session required.
router.get("/by-handle/:handle", getPublicStore);

// Vendor-owned store management.
router.get("/me", verifyAuth, getMyStore);
router.put("/me", verifyAuth, updateMyStore);

// Connected Catalogs (spec §16.1) — connect the vendor's own website.
router.post("/connect-catalog", verifyAuth, connectCatalog);

export default router;
