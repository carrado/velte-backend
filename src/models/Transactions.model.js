import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    customerId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: String, // stored as formatted string e.g. "01-01-2025"
      required: true,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "NGN",
    },
    method: {
      type: String,
      enum: ["CC", "PayPal", "Bank"],
      required: true,
    },
    status: {
      type: String,
      enum: ["Complete", "Pending", "Canceled"],
      default: "Pending",
    },
    reference: {
      type: String,
      unique: true,
      sparse: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        ret.id = ret._id.toString();
        // Format total as currency string for frontend (NGN)
        ret.total = `₦${Number(ret.total).toLocaleString()}`;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Indexes for common query patterns
transactionSchema.index({ userId: 1, status: 1 });
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, method: 1 });

const Transaction = mongoose.model("Transaction", transactionSchema);

export default Transaction;