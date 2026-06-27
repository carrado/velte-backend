// Manual push tester — isolates web-push from the order flow.
//   1. Subscribe in the app (Settings → Push toggle, or the modal).
//   2. Run:  node scripts/testPush.mjs
// It prints how many subscriptions exist for the merchant and the exact
// per-subscription delivery result/error (status + body).
import "dotenv/config";
import mongoose from "mongoose";
import { notifyUser } from "../src/services/pushNotification.service.js";

const MERCHANT_ID = process.argv[2] || "6a136f17f17da368fbf694c5";

await mongoose.connect(process.env.MONGODB_URI);
console.log(`Sending test push to merchant ${MERCHANT_ID}…`);

await notifyUser(MERCHANT_ID, {
  type: "payment",
  title: "Test push ✅",
  body: "If you see this, web-push is working end-to-end.",
  url: `/${MERCHANT_ID}/orders`,
  tag: "test-push",
  requireInteraction: true,
});

await mongoose.disconnect();
console.log("Done. Check the [Push] log lines above for the result.");
