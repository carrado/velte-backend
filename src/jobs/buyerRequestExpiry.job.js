import BuyerRequest from "../models/BuyerRequest.model.js";

// Sweeps active requests past their expiresAt into "expired" — spec §11/§36.
// A plain bulk update, not per-document logic: once flipped, a request
// naturally stops being matched to vendors (listMatchedRequests filters
// status: "active") and stops generating response SMS
// (processBuyerRequestResponseNotifications filters the same way) — no
// extra code needed in either place, status alone gates both. It stays
// visible in the buyer's own history (getMyRequests has no status filter).
export async function expireBuyerRequests() {
  const { modifiedCount } = await BuyerRequest.updateMany(
    { status: "active", expiresAt: { $lt: new Date() } },
    { $set: { status: "expired" } },
  );
  if (modifiedCount) {
    console.log(`[buyerRequestExpiry] expired ${modifiedCount} request(s)`);
  }
}
