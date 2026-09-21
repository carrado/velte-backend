import express from "express";
import {
  createShoppingPlan,
  getShoppingPlan,
  listShoppingPlans,
  listManageableShoppingPlans,
  updateShoppingPlan,
  markItemPurchased,
  addPlanItem,
  updatePlanItem,
} from "../controllers/shoppingPlan/shoppingPlan.controller.js";
import { resolveActor } from "../middleware/resolveActor.js";

const router = express.Router();

// resolveActor, same as notifications.routes.js / the deleted
// shoppingListJob.routes.js — never 401s on its own; the controller's own
// requireOwner() answers that with a clean message for a genuine guest.
// Buyer or vendor both work, resolveActor already prefers buyer when both
// cookies exist.
router.use(resolveActor);

router.post("/", createShoppingPlan);
router.get("/", listShoppingPlans);
// Mounted BEFORE /:id — Express matches routes in registration order, and
// "manageable" would otherwise be swallowed as an :id.
router.get("/manageable", listManageableShoppingPlans);
router.get("/:id", getShoppingPlan);
router.patch("/:id", updateShoppingPlan);
router.post("/:id/items", addPlanItem);
router.patch("/:id/items/:itemId", updatePlanItem);
// select/dismiss-alternative routes removed 2026-09-20 (explicit product
// decision) — see shoppingPlan.controller.js's own markItemPurchased
// comment. Purchase now takes a candidateId in its body instead of relying
// on a standing selection.
router.patch("/:id/items/:itemId/purchase", markItemPurchased);

export default router;
