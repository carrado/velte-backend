import BuyerRequest from "../models/BuyerRequest.model.js";

// Sweeps active requests past their expiresAt into "expired" — spec §11/§36.
// A plain bulk update, not per-document logic: once flipped, a request
// naturally stops being matched to vendors (listMatchedRequests filters
// status: "active") — no extra code needed there, status alone gates it.
export async function expireBuyerRequests() {
  const { modifiedCount } = await BuyerRequest.updateMany(
    { status: "active", expiresAt: { $lt: new Date() } },
    { $set: { status: "expired" } },
  );
  if (modifiedCount) {
    console.log(`[buyerRequestExpiry] expired ${modifiedCount} request(s)`);
  }
}
