import express from "express";
import { verifyAuth } from "../middleware/auth.js";
import {
  getCustomers,
  getCustomerStats,
} from "../controllers/customers/customers.controller.js";

const router = express.Router();

// New-customers-per-day series for the overview chart. Declared before "/" — both
// are exact paths so order is not strictly required, but keep the specific one first.
router.get("/stats", verifyAuth, getCustomerStats);

// List the authenticated business's customers.
router.get("/", verifyAuth, getCustomers);

export default router;
