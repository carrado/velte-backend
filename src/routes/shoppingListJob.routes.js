import express from "express";
import {
  createShoppingListJob,
  getShoppingListJob,
  listShoppingListJobs,
  setItemRecommendation,
} from "../controllers/shoppingList/shoppingListJob.controller.js";
import { resolveActor } from "../middleware/resolveActor.js";

const router = express.Router();

// resolveActor, same as notifications.routes.js — never 401s on its own,
// the controller's own requireOwner() answers that with a clean message
// for a genuine guest. Buyer or vendor both pass now (2026-09-17, see
// shoppingListJob.controller.js's own header) — resolveActor already
// prefers buyer when both cookies exist, so this needs no extra logic here.
router.use(resolveActor);

router.post("/", createShoppingListJob);
router.get("/", listShoppingListJobs);
router.get("/:id", getShoppingListJob);
router.patch("/:id/items/:itemId/recommendation", setItemRecommendation);

export default router;
