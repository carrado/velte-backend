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
    productId: String, // underlying products._id, so the velte order can snapshot the photo
    productImage: String, // Product.mainImageUrl at checkout time
    amount: Number, // grand total = Σ line totals
    quantity: Number, // total units = Σ line quantities (staffly default 1)
    // Per-variant breakdown written by staffly (one entry for a plain order,
    // several for a multi-variant order, e.g. 3 red + 1 black). Read loosely.
    items: [
      {
        name: String, // display label, e.g. "T-Shirt (Red)"
        variant: String, // "Red, L" (null/absent = no variant)
        quantity: Number,
        unitPrice: Number, // per-unit price incl. modifier add-ons
        lineTotal: Number, // unitPrice × quantity
        attributes: [{ name: String, value: String, _id: false }],
        modifiers: [
          { group: String, name: String, additionalPrice: Number, _id: false },
        ],
        _id: false,
      },
    ],
    status: String, // pending | paid | failed
    customerName: String,
    customerEmail: String,
    location: String, // delivery address gathered during WhatsApp checkout
  },
  { collection: "staffly_orders", timestamps: true },
);

export default mongoose.models.StafflyOrder ||
  mongoose.model("StafflyOrder", StafflyOrderSchema);
