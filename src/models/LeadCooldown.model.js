import mongoose from "mongoose";

// One doc per (vendorId, buyerId) pair, alive for exactly the cooldown
// window — its own existence IS the "already charged recently" signal, no
// separate charged-at comparison needed. TTL expiry is what naturally lets
// the SAME buyer be charged again once the window passes (see chargeLead).
// `buyerId` is an anonymous, per-browser id (see frontend's reportLead.ts)
// — never a real account, so a buyer clearing storage or switching devices
// just looks like a new buyer, which is an acceptable, deliberate tradeoff
// for not requiring buyer accounts.
export const LEAD_COOLDOWN_SECONDS = 15 * 60;

const leadCooldownSchema = new mongoose.Schema({
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  buyerId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: LEAD_COOLDOWN_SECONDS },
});

leadCooldownSchema.index({ vendorId: 1, buyerId: 1 }, { unique: true });

export default mongoose.model("LeadCooldown", leadCooldownSchema);
