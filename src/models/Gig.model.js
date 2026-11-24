import mongoose from "mongoose";

// A task, job, or bounty posted by a vendor for buyers/agents to win and complete.
const gigMilestoneSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    amountKobo: { type: Number, required: true, min: 0 },
    completed: { type: Boolean, default: false },
  },
  { _id: true },
);

const gigSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 3000,
    },
    category: {
      type: String,
      enum: [
        "audit_kyc",
        "delivery_logistics",
        "photography_media",
        "marketing_promotion",
        "technical_service",
        "inventory_warehouse",
        "job",
        "service",
        "custom",
      ],
      default: "custom",
      index: true,
    },
    imageUrl: {
      type: String,
      default: null,
    },
    images: {
      type: [String],
      default: [],
    },
    workMode: {
      type: String,
      enum: ["remote", "on-site", "hybrid"],
      default: "on-site",
    },
    location: {
      type: String,
      default: "Nigeria",
      trim: true,
    },
    rewardType: {
      type: String,
      enum: ["instant", "milestone"],
      default: "instant",
    },
    rewardKobo: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    milestones: {
      type: [gigMilestoneSchema],
      default: [],
    },
    deadline: {
      type: Date,
      default: null,
    },
    requiredSkills: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ["open", "assigned", "submitted", "completed", "cancelled"],
      default: "open",
      index: true,
    },
    assignedBuyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      default: null,
      index: true,
    },
    assignedApplicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GigApplication",
      default: null,
    },
    applicantCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

gigSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model("Gig", gigSchema);

