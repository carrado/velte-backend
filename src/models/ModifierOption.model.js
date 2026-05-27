import mongoose from 'mongoose';

const modifierOptionSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    additionalPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

// One option name per vendor — price lives here, shared across all products
modifierOptionSchema.index({ vendorId: 1, name: 1 }, { unique: true });

export default mongoose.model('ModifierOption', modifierOptionSchema);
