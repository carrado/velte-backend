import mongoose from 'mongoose';

// Deliberately separate from Users.js (vendor-shaped: trustScore,
// paystackSubaccount, sectors, etc.) rather than a role flag on that model —
// see docs/velte_buyer_requests_mvp_spec.md §62's confirmed fork. Kept
// minimal per spec §3/§63: name, phone, location, nothing else, so signup
// friction stays as low as the product intends.
const buyerSchema = new mongoose.Schema({
  name: {
    type: String,
    default: null,
    trim: true,
  },
  // Always known at creation (a Buyer doc is upserted by phone the moment
  // an OTP is first requested) — unlike User.phone this is never null, so a
  // plain unique index is safe here without Users.js's partial-index
  // null-collision workaround.
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  // Buyer-facing identity, distinct from phone (never shown to vendors) —
  // set once at verify-otp time. Unique across all buyers, same lowercase
  // slug convention as Store.model.js's `handle`. Sparse so the many
  // buyers who verified before this field existed don't collide on `null`.
  username: {
    type: String,
    default: null,
    trim: true,
    lowercase: true,
    unique: true,
    sparse: true,
  },
  phoneOtp: {
    code: {
      type: Number,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  phoneVerified: {
    type: Boolean,
    default: false,
  },
  // Same GeoJSON Point shape as Users.js's vendor geo, for consistency with
  // whatever downstream code (matching, distance calc) already expects that
  // shape. Optional — a buyer can verify with just phone+code and add this
  // later (see §63.3's "do not ask for unnecessary onboarding information").
  location: {
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number], default: undefined }, // [lng, lat]
  },
  area: {
    type: String,
    default: null,
  },
  state: {
    type: String,
    default: null,
  },
}, {
  timestamps: true,
});

buyerSchema.index({ location: '2dsphere' });

// Strip the OTP out of any serialized response, same defensive reasoning as
// Users.js's toJSON transform — belt-and-suspenders in case a query forgets
// to .select() it out.
buyerSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.phoneOtp;
    return ret;
  },
});

export default mongoose.model('Buyer', buyerSchema);
