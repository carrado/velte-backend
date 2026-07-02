import mongoose from "mongoose";

// Ledger row for every wallet balance change — top-ups (credit) and lead
// charges (debit). Immutable once written; `status` only moves pending → success
// or pending → failed for async top-ups (bank transfer / webhook-confirmed).
const walletTransactionSchema = new mongoose.Schema(
  {
    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      index: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: { type: String, enum: ["topup", "debit"], required: true },
    amountKobo: { type: Number, required: true, min: 0 },
    balanceAfterKobo: { type: Number, required: true, min: 0 },

    // Idempotency key — a Paystack reference for top-ups, or a leadId for debits.
    // Unique index declared below (not `index: true` here, to avoid a duplicate).
    reference: { type: String, required: true },

    status: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "success",
    },

    // 'card' | 'dedicated_nuban' | 'lead'
    channel: { type: String, default: null },
    description: { type: String, default: null },
  },
  { timestamps: true },
);

// A given reference should only ever post one ledger row (webhook retries,
// double-clicks on verify, etc. must not double-credit/debit).
walletTransactionSchema.index({ reference: 1 }, { unique: true });

export default mongoose.model("WalletTransaction", walletTransactionSchema);
