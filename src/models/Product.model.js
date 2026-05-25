import mongoose from 'mongoose';

const modifierOptionSchema = new mongoose.Schema({
  id:              { type: String, required: true },
  name:            { type: String, required: true },
  additionalPrice: { type: Number, default: 0 },
}, { _id: false });

const modifierSchema = new mongoose.Schema({
  id:          { type: String, required: true },
  name:        { type: String, required: true },
  required:    { type: Boolean, default: false },
  multiSelect: { type: Boolean, default: false },
  options:     { type: [modifierOptionSchema], default: [] },
}, { _id: false });

const availabilitySchema = new mongoose.Schema({
  days:      { type: [String], default: [] },
  startTime: { type: String, default: null },
  endTime:   { type: String, default: null },
}, { _id: false });

const productSchema = new mongoose.Schema({
  merchantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name:        { type: String, required: true, trim: true },
  description: { type: String, default: null },
  price:       { type: Number, required: true },
  category:    { type: String, default: null },
  imageUrl:    { type: String, default: null },
  inStock:     { type: Boolean, default: true },

  // Food-specific fields
  modifiers:         { type: [modifierSchema], default: [] },
  availability:      { type: availabilitySchema, default: null },
  estimatedPrepMins: { type: Number, default: null },
  isVeg:             { type: Boolean, default: false },
  isSpicy:           { type: Boolean, default: false },
}, {
  timestamps: true,
});

export default mongoose.model('Product', productSchema);
