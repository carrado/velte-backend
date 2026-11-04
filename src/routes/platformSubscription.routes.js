import { Router } from "express";

import { resolveActor } from "../middleware/resolveActor.js";
import {
  checkoutSubscription,
  savePremiumAddress,
  startEnterpriseTrial,
  startNinCheck,
  verifySubscription,
} from "../controllers/subscriptions/platformSubscription.controller.js";

const router = Router();

router.use(resolveActor);
router.post("/address", savePremiumAddress);
router.post("/nin", startNinCheck);
router.post("/checkout", checkoutSubscription);
router.post("/trial", startEnterpriseTrial);
router.post("/verify", verifySubscription);

export default router;
