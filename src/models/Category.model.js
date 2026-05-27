import mongoose from 'mongoose';

// Retail categories are a fixed, seeded list — not per-vendor.
// String _id matches the slug used as category_id on products (e.g. "electronics").
const categorySchema = new mongoose.Schema(
  {
    _id:   { type: String },
    name:  { type: String, required: true },
    emoji: { type: String, default: null },
  },
  { timestamps: false }
);

export default mongoose.model('Category', categorySchema);
