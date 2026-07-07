import mongoose from 'mongoose';

// One row per referred signup — separate from User.referredBy so the
// crediting lifecycle (pending → credited) has somewhere to live without
// overloading the User schema, and so a vendor's referral history/stats page
// has a real collection to query and paginate.
const referralSchema = new mongoose.Schema({
  referrerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // Unique: one referral record per referred vendor — a vendor can only ever
  // have been referred once, by whoever's code they signed up with.
  refereeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  code: {
    type: String,
    required: true,
  },
  // "pending" until the referee verifies their email (see auth.js
  // verifyEmail) — the deliberate anti-abuse gate: a bare signup with no real
  // email behind it never converts to a payout. "credited" is terminal.
  status: {
    type: String,
    enum: ['pending', 'credited'],
    default: 'pending',
  },
  bonusKobo: {
    type: Number,
    required: true,
  },
  creditedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

referralSchema.index({ referrerId: 1, status: 1 });
referralSchema.index({ referrerId: 1, createdAt: -1 });

export default mongoose.model('Referral', referralSchema);
