import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  company: {
    name: {
    type: String,
    default: null,
    },
    location: {
      type: String,
      default: null,  
    },
    phone: {
      type: String,
      default: null,
    },
    services: {
      type: [String],
      default: null
    },
    state: {
      type: String,
      default: null,
    },
  },
  country: {
    type: String,
    default: null
  },
  avatar: {
    type: String,
    default: null,
  },
  phone: {
    type: String,
    default: null,
  },
  username: {
    type: String,
    default: null,
  },
  emailOtp: {
    code: {
      type: Number,
      default: null
    },
    expiresAt: {
      type: Number,
      default: null
    }
  },
  changePasswordOtp: {
    code: {
      type: Number,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null
    }
  },
  accountVerified: {
    type: Boolean,
    default: false
  },
  // Admin-side account block (super admin panel) — checked at login. Distinct
  // from the broken, unpersisted `activeStatus` self-deactivation flow in
  // deleteAccount (that field isn't in this schema, so it silently no-ops).
  isBlocked: {
    type: Boolean,
    default: false
  },
  // The message the super admin typed when blocking — shown to the user in
  // the block modal (login rejection and mid-session force-logout both
  // surface this same string).
  blockReason: {
    type: String,
    default: null
  },
  kycStatus: {
    type: String,
    required: false,
    default: 'not-verified'
  },
  onboarding: {
    type: Boolean,
    default: true
  },
  // The vendor's operating sectors (taxonomy slugs, e.g. "phones_accessories")
  // — chosen at signup, editable later from the Store editor. Drives listing
  // shape per-listing (see Product.sectorValue) rather than one frozen
  // account-wide businessType. Capped at 5 (enforced in the controller).
  sectors: {
    type: [String],
    default: [],
  },
  description: {
    type: String,
    default: '',
    maxlength: 600,
  },
  preferences: {
    defaultCurrency: {
      type: String,
      default: '₦'
    },
    foodSettings: {
      estimatedPrepMins: { type: Number, default: 20 },
      autoAccept:        { type: Boolean, default: false },
    },
  },

  // ── Velte Connect vendor fields (discovery matching: geo + trust + payouts) ──
  geo: {
    type:        { type: String, enum: ['Point'] },
    coordinates: { type: [Number], default: undefined }, // [lng, lat]
  },
  area:               { type: String, default: null }, // neighbourhood/market tag
  state:              { type: String, default: null }, // Nigerian state — structured part of the address
  // When area/state/geo was last changed — gates how often a vendor can move
  // their pinned location, since discovery matching ranks by proximity and an
  // instantly-movable address is an easy way to game "nearest vendor" results.
  addressChangedAt:   { type: Date, default: null },
  trustScore:         { type: Number, default: 0, min: 0, max: 100 },
  paystackSubaccount: { type: String, default: null },
  hiddenFromSearch:   { type: Boolean, default: false },

  // ── Referrals ──────────────────────────────────────────────────────────────
  // Every vendor gets one at signup (see auth.js register) so they always have
  // something to share, whether or not they ever use it.
  referralCode: { type: String, default: null, unique: true, sparse: true },
  // Set once, at signup, from whatever referral code (if any) they signed up
  // with — never changes after. null for a vendor who signed up organically.
  referredBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true
});

userSchema.index({ geo: '2dsphere' });

// Two accounts can't share a phone number — a `unique: true` shorthand on
// the field itself would break the moment a SECOND user registered with no
// phone at all (Mongoose writes an explicit `null`, and a plain unique
// index treats every null as a duplicate of every other null; `sparse`
// alone doesn't fix this either, since sparse only skips a field that's
// truly MISSING, not one explicitly set to null). A partial index sidesteps
// both: only documents where phone is an actual string are ever compared,
// so any number of null-phone accounts coexist fine, and only genuine
// duplicate real numbers get rejected. Also enforced at the application
// layer with a friendly error before this ever fires — see auth.js
// register() and updateProfile.js — this is the DB-level backstop.
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string" } } },
);

// Serialise the document with a string `id` (mirrors the shape login returns) so
// every consumer of a user — /auth/me included — gets `id`, not just `_id`. The
// frontend's `User.id` (and push-subscribe) depend on it. `_id` is kept for any
// existing reader. Also strip secrets defensively, in case a query forgets to
// .select() them out.
userSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.emailOtp;
    delete ret.changePasswordOtp;
    return ret;
  },
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model('User', userSchema);