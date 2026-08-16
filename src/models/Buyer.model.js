import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

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
  // 2026-08-15 — added alongside password/login unification (auth.js's
  // login now looks a buyer up the exact same way it looks a vendor up:
  // email or username + password). Only set at verify-otp time (same as
  // password) — NOT collected at request-otp, since that's just the "prove
  // you own this phone" step. `sparse` so buyers who verified before this
  // field existed don't collide on `null`; uniqueness against the VENDOR
  // collection (a buyer and a vendor can never share an email, same as
  // phone) is enforced in the controller, not here — Mongoose can't express
  // a unique constraint across two different collections.
  email: {
    type: String,
    default: null,
    trim: true,
    lowercase: true,
    unique: true,
    sparse: true,
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
  // 2026-08-15: password auth added alongside phone+OTP — OTP still proves
  // phone ownership once, at signup (verifyOtp), but a returning buyer now
  // logs in with email/username+password via the UNIFIED login (auth.js's
  // login, which falls back to this collection when no vendor matches) —
  // not a buyer-specific endpoint. `select: false` so a plain `Buyer.findOne`
  // never leaks the hash; that unified login explicitly `.select('+password')`s
  // it. Optional for the same reason `username` is: buyers who verified
  // before this field existed have none, and that's fine — they just can't
  // log in until they sign up again the normal way.
  password: {
    type: String,
    select: false,
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
    delete ret.password;
    return ret;
  },
});

// Same hash-on-save pattern as Users.js — only re-hashes when `password` was
// actually assigned this save (so verifyOtp setting name/location on a
// buyer that already has a password doesn't re-hash the existing hash).
buyerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

buyerSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model('Buyer', buyerSchema);
