import BuyerSavedItem from "../../models/BuyerSavedItem.model.js";
import Buyer from "../../models/Buyer.model.js";
import { AppError } from "../../middleware/errorHandler.js";

// ── GET /api/vendor/followers ────────────────────────────────────────────
// The vendor-facing counterpart to buyerSaved.controller.js's toggleSaved —
// same split as buyerRequests.controller.js / vendorBuyerRequests.controller.js
// (buyer-facing action, vendor-facing read of the same underlying data).
//
// Deliberately returns name/username and nothing else — NEVER phone. A
// vendor can see WHO follows their store (real social proof), but Velte
// doesn't hand them a channel to contact a buyer outside the buyer's own
// choice to initiate (a Buyer Request response, or tapping "Chat" on a
// listing). Selecting only these two fields is defense in depth even
// against a future accidental widening of this query — phone is never in
// scope to leak here.
export async function getMyFollowers(req, res, next) {
  try {
    const vendorId = req.user.userId;
    const follows = await BuyerSavedItem.find({ kind: "vendor", targetId: vendorId })
      .sort({ createdAt: -1 })
      .lean();

    const buyerIds = follows.map((f) => f.buyerId);
    const buyers = await Buyer.find({ _id: { $in: buyerIds } })
      .select("name username")
      .lean();
    const buyerById = new Map(buyers.map((b) => [String(b._id), b]));

    const followers = follows
      .map((f) => {
        const buyer = buyerById.get(String(f.buyerId));
        if (!buyer) return null; // a since-deleted buyer account
        return {
          name: buyer.name,
          username: buyer.username,
          followedAt: f.createdAt,
        };
      })
      .filter(Boolean);

    res.status(200).json({ success: true, data: { followers } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
