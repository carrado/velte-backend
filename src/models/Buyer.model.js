import mongoose from 'mongoose';

// 2026-08-18 — stripped back to the bare minimum per explicit product
// direction ("Just the Phone and OTP Verification, nothing buyers again on
// the system. Buyers still remain anonymous for now"): this is no longer an
// account model at all, just a phone-verification record. Everything that
// used to make this a real account — email/username/password login, saved
// location, name — is gone. A buyer's name for a given request now lives
// only on that BuyerRequest doc (see its own comment), never here; there is
// no buyer "profile" anywhere in the product to attach one to.
const buyerSchema = new mongoose.Schema({
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
}, {
  timestamps: true,
});

// Strip the OTP out of any serialized response — belt-and-suspenders in
// case a query forgets to .select() it out.
buyerSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.phoneOtp;
    return ret;
  },
});

export default mongoose.model('Buyer', buyerSchema);
