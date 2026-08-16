import express from "express";
import { verifyBuyerAuth } from "../middleware/buyerAuth.js";
import {
  upsertConversation,
  listConversations,
  getConversation,
  deleteConversation,
} from "../controllers/buyerConversations/buyerConversations.controller.js";

const router = express.Router();

router.use(verifyBuyerAuth);

router.post("/", upsertConversation);
router.get("/", listConversations);
router.get("/:id", getConversation);
router.delete("/:id", deleteConversation);

export default router;
