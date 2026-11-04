import mongoose from "mongoose";

// One cart checkout. A cart is one vendor, so an order is one vendor too —
// commission math, stock decrements, and the later transfer all stay
// attributable to a single seller.
//
// Settlement is ESCROW: Paystack charges Velte's main balance on
// `charge.success`. The vendor's share leaves only when the vendor has
// ACCEPTED and delivery is approved (courier, or vendor-as-courier) —
// see docs/velte-order-tracking-settlement-plan.md. Confirm no longer
// pays. The recipient code is snapshotted at payment so a later
// payout-account change cannot reroute money already owed.

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    name: { type: String, required: true },
    imageUrl: { type: String, default: null },
    unitPriceKobo: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotalKobo: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    items: { type: [orderItemSchema], required: true },

    // Display name of the store at checkout. Snapshotted so a later rename
    // does not rewrite the buyer's order history.
    vendorName: { type: String, default: null },
    storeHandle: { type: String, default: null },

    // Who to deliver to. Collected at checkout, shown to the vendor on
    // confirm. Optional at the schema layer so orders placed before this
    // existed can still be confirmed; checkout itself requires all three.
    fulfillment: {
      name: { type: String, default: null },
      phone: { type: String, default: null },
      address: { type: String, default: null },
    },

    // Snapshot of computeCharge() at initialize time. Buyer pays `totalKobo`;
    // vendor is later transferred `subtotalKobo` (the listed prices).
    subtotalKobo: { type: Number, required: true, min: 0 },
    commissionKobo: { type: Number, required: true, min: 0 },
    paystackFeeKobo: { type: Number, required: true, min: 0 },
    totalKobo: { type: Number, required: true, min: 0 },

    // Timeline (what the buyer/vendor see). Money is `settlement`, not this.
    // Legacy `confirmed` rows with a transferReference read as received+released.
    status: {
      type: String,
      enum: [
        "pending",
        "paid",
        "accepted",
        "dispatched",
        "delivered",
        "received",
        "disputed",
        "confirmed",
        "cancelled",
        "refunded",
      ],
      default: "pending",
      index: true,
    },
    settlement: {
      type: String,
      enum: [
        "none",
        "escrowed",
        "frozen",
        "releasing",
        "released",
        "refunding",
        "refunded",
        "failed",
      ],
      default: "none",
    },
    acceptedAt: { type: Date, default: null },
    dispatchedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    /** Buyer confirm-or-dispute deadline. Set when delivery is approved. */
    confirmBy: { type: Date, default: null },
    reminderSentAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    disputedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    courierApprovedAt: { type: Date, default: null },
    pickupCode: { type: String, default: null },
    dispatch: {
      method: { type: String, enum: ["self", "courier"], default: null },
      carrier: { type: String, default: null },
      trackingCode: { type: String, default: null },
      note: { type: String, default: null },
      photoUrls: { type: [String], default: [] },
    },
    dispute: {
      reason: {
        type: String,
        enum: ["not_received", "wrong_item", "damaged", "other"],
        default: null,
      },
      detail: { type: String, default: null },
      photoUrls: { type: [String], default: [] },
      openedAt: { type: Date, default: null },
      resolvedAt: { type: Date, default: null },
      resolution: {
        type: String,
        enum: ["release", "refund"],
        default: null,
      },
    },

    paystackReference: { type: String, required: true, unique: true },
    paidAt: { type: Date, default: null },

    // Copied from User.payout at the moment of payment. The later transfer
    // uses THIS, not whatever the vendor has on file that day.
    payoutRecipientCode: { type: String, default: null },
    transferReference: { type: String, default: null },
    transferCode: { type: String, default: null },
    transferredAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

orderSchema.index({ vendorId: 1, status: 1, createdAt: -1 });
orderSchema.index({ buyerId: 1, createdAt: -1 });

export default mongoose.model("Order", orderSchema);
