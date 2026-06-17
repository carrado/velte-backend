import mongoose from "mongoose";

/**
 * Read-only mirror of Staffly's `staffly_orders` collection (owned and written
 * by staffly-backend's models/mongoose/StafflyOrder.js). velte and staffly share
 * the same MongoDB, so the pay page can resolve a checkout intent by its
 * `orderId` (the `ref` carried on a velte pay link) to charge the authoritative
 * amount and build Paystack `metadata.stafflyOrderId`.
 *
 * Do NOT write to this from velte — staffly owns the lifecycle (it flips status
 * to "paid" when it receives the order.paid webhook).
 */
const StafflyOrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, index: true },
    businessId: String,
    customerNumber: String,
    product: String,
    amount: Number,
    status: String, // pending | paid | failed
    customerName: String,
    customerEmail: String,
    location: String,
  },
  { collection: "staffly_orders", timestamps: true },
);

export default mongoose.models.StafflyOrder ||
  mongoose.model("StafflyOrder", StafflyOrderSchema);
