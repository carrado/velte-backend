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
  kycStatus: {
    type: String,
    required: false,
    default: 'not-verified'
  },
  onboarding: {
    type: Boolean,
    default: true
  },
  businessType: {
    type: String,
    enum: ['retail', 'food'],
    default: 'retail',
  },
  // Per-store running counter for receipt numbers (atomically $inc'd on each paid
  // order). Combined with the business abbreviation → e.g. "ASL-0001".
  receiptSequence: {
    type: Number,
    default: 0,
  },
  preferences: {
    notifications: {
      email:            { type: Boolean, default: true },
      inApp:            { type: Boolean, default: false },
      orders:           { type: Boolean, default: true },
      invoices:         { type: Boolean, default: false },
      invoiceThreshold: { type: Number,  default: 0, min: 0 },
      productUpdates:   { type: Boolean, default: false },
      push:             { type: Boolean, default: true },
    },
    defaultCurrency: {
      type: String,
      default: '₦'
    },
    foodSettings: {
      estimatedPrepMins: { type: Number, default: 20 },
      autoAccept:        { type: Boolean, default: false },
    },
    // Invoice & Receipt document templates (Settings → Invoice & Receipt).
    // The logo is NOT stored here — documents use the account photo (`avatar`).
    documentSettings: {
      invoice: {
        business: {
          name:    { type: String, default: '' },
          address: { type: String, default: '' },
          phone:   { type: String, default: '' },
          email:   { type: String, default: '' },
          taxId:   { type: String, default: '' },
          website: { type: String, default: '' },
        },
        footerNote:    { type: String, default: 'Thank you for your business! Payment is due within the specified period.' },
        primaryColor:  { type: String, default: '#f97316' },
        bankName:      { type: String, default: '' },
        accountNumber: { type: String, default: '' },
        accountName:   { type: String, default: '' },
        dueDays:       { type: Number, default: 7, min: 0 },
        // CDN URL of the generated template PDF (sample data) — set on save.
        templatePdfUrl: { type: String, default: null },
      },
      receipt: {
        business: {
          name:    { type: String, default: '' },
          address: { type: String, default: '' },
          phone:   { type: String, default: '' },
          email:   { type: String, default: '' },
          taxId:   { type: String, default: '' },
          website: { type: String, default: '' },
        },
        thankYouMessage: { type: String, default: 'Thank you for your purchase!' },
        returnPolicy:    { type: String, default: 'Items can be returned within 7 days with original receipt.' },
        primaryColor:    { type: String, default: '#f97316' },
        showBarcode:     { type: Boolean, default: true },
        // CDN URL of the generated template PDF (sample data) — set on save.
        templatePdfUrl:  { type: String, default: null },
      },
    },
    // AI behaviour settings (Settings → AI Settings): operating hours + the
    // escalation trigger. `escalation.threshold` is a fixed order-total amount
    // (Naira) enforced server-side — the UI shows it locked.
    aiSettings: {
      // 24/7 availability is enforced for Phase 1. Custom operating hours
      // (openTime/closeTime/offlineMessage) are deferred to Phase 2.
      shopHours: {
        is24Hours: { type: Boolean, default: true },
      },
      escalation: {
        enabled:   { type: Boolean, default: false },
        threshold: { type: Number, default: 1000000 },
      },
    },
  },
}, {
  timestamps: true
});

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