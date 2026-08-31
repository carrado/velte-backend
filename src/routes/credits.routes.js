import express from "express";
import { resolveActor } from "../middleware/resolveActor.js";
import {
  consumeCredits,
  getCredits,
  initTopUp,
  listPacks,
  refundCredits,
} from "../controllers/credits/credits.controller.js";

const router = express.Router();

// resolveActor, not verifyBuyerAuth: a signed-in VENDOR browsing /chat spends
// on the same terms as a buyer. The buyer-only guard here is what once made a
// vendor look anonymous to the search gate and be told to "sign in" while
// already signed in.
//
// It never 401s; the controller does, if there turns out to be no account at
// all. Guests never reach these routes — their balance is honour-system in
// browser storage and the frontend answers them without a round trip.
router.use(resolveActor);

router.get("/", getCredits);
router.post("/consume", consumeCredits);
router.post("/refund", refundCredits);
router.get("/packs", listPacks);
router.post("/checkout", initTopUp);

// NOTE: there is deliberately no grant route. Credits are granted server-side
// by the flows that earn them (account creation, referral completion, a
// verified Paystack top-up) via grantCredits() — a route that handed out
// credits is a route a client could use to mint them.

export default router;
