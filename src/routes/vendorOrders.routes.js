import express from "express";
import { verifyAuth } from "../middleware/auth.js";
import {
  listVendorOrders,
  getVendorOrder,
  confirmVendorOrder,
  dispatchVendorOrder,
  deliverVendorOrder,
} from "../controllers/orders/vendorOrders.controller.js";

const router = express.Router();

router.use(verifyAuth);

router.get("/", listVendorOrders);
router.get("/:id", getVendorOrder);
router.post("/:id/confirm", confirmVendorOrder);
router.post("/:id/accept", confirmVendorOrder);
router.post("/:id/dispatch", dispatchVendorOrder);
router.post("/:id/deliver", deliverVendorOrder);

export default router;
