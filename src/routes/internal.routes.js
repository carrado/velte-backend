import express from "express";
import { verifyStafflySignature } from "../middleware/staffly.signature.verify.js";
import { createOrderFromStaffly } from "../controllers/orders/orderPayment.controller.js";

// Internal service-to-service routes (staffly → velte), authenticated by a shared
// HMAC signature rather than a user session. Mounted at /api/internal. The body is
// raw (mounted in app.js before express.json) so the signature can be verified over
// the exact bytes staffly signed.
const router = express.Router();

router.post(
  "/orders/from-staffly",
  verifyStafflySignature,
  createOrderFromStaffly,
);

export default router;
