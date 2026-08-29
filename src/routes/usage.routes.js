import express from "express";
import { resolveActor } from "../middleware/resolveActor.js";
import {
  consumeSearch,
  getUsage,
} from "../controllers/usage/usage.controller.js";

const router = express.Router();

// resolveActor, not verifyBuyerAuth: metering applies to a signed-in VENDOR
// browsing /chat exactly as much as to a buyer. Using the buyer-only guard
// here is what made a vendor look anonymous to the search gate — they were
// told to "sign in" before using photo search while already signed in.
//
// It never 401s; the controller does, if there turns out to be no account at
// all. Guests never reach this route — the frontend answers them from the
// plan table without a round trip.
router.use(resolveActor);

router.get("/", getUsage);
router.post("/consume", consumeSearch);

export default router;
