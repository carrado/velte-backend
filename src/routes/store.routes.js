import express from "express";
import { verifyAuth } from "../middleware/auth.js";
import {
  getMyStore,
  updateMyStore,
  getPublicStore,
} from "../controllers/store/store.controller.js";

const router = express.Router();

// Public — powers the /store/:handle page, no session required.
router.get("/by-handle/:handle", getPublicStore);

// Vendor-owned store management.
router.get("/me", verifyAuth, getMyStore);
router.put("/me", verifyAuth, updateMyStore);

export default router;
