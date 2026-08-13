import express from "express";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";
import {
  getMyNotifications,
  markRead,
  markAllRead,
} from "../controllers/buyerNotifications/buyerNotifications.controller.js";

const router = express.Router();

router.use(verifyBuyerAuth);

router.get("/", getMyNotifications);
router.patch("/:id/read", markRead);
router.patch("/read-all", markAllRead);

export default router;
