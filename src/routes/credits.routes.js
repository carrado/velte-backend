import express from "express";
import { resolveActor } from "../middleware/resolveActor.js";
import {
  checkGuestIpUsage,
  consumeCredits,
  getCredits,
  initTopUp,
  initWalletTopUp,
  listPacks,
  refundCredits,
  verifyCreditTopUp,
} from "../controllers/credits/credits.controller.js";

const router = express.Router();

// resolveActor, not verifyBuyerAuth: a signed-in VENDOR browsing /chat spends
// on the same terms as a buyer. The buyer-only guard here is what once made a
// vendor look anonymous to the search gate and be told to "sign in" while
// already signed in.
//
// It never 401s; the controller does, if there turns out to be no account at
// all. A GUEST reaches exactly one route below now (/guest-usage,
// 2026-09-05) — every other route here still expects a real account, and
// their own PERSONAL balance is still honour-system in browser storage,
// answered by the frontend without a round trip. /guest-usage is a
// different thing: a NETWORK-level backstop that was never inside any one
// guest's browser to begin with, so it is the one guest-relevant fact this
// service can actually hold. See its own controller comment.
router.use(resolveActor);

router.get("/", getCredits);
router.post("/consume", consumeCredits);
router.post("/refund", refundCredits);
router.get("/packs", listPacks);
router.post("/checkout", initTopUp);
// Confirms a card top-up directly with Paystack instead of only waiting on
// the webhook — safe to call even if the webhook already landed (or lands
// later); see verifyCreditTopUp's own comment.
router.post("/verify-topup", verifyCreditTopUp);
// Vendors only, and it settles in the request rather than through
// Paystack -- the money is already ours. See initWalletTopUp.
router.post("/wallet-topup", initWalletTopUp);
// GUEST-only, and public — see checkGuestIpUsage's own comment for why an
// unauthenticated route is the right call here.
router.post("/guest-usage", checkGuestIpUsage);

// NOTE: there is deliberately no grant route. Credits are granted server-side
// by the flows that earn them (account creation, referral completion, a
// verified Paystack top-up) via grantCredits() — a route that handed out
// credits is a route a client could use to mint them.

export default router;
