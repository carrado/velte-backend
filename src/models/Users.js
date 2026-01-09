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
  accountType: {
    type: String,
    enum: ['customer', 'vendor'],
    default: 'customer'
  },
  profile: {
    avatar: {
      type: String,
      default: null,
    },
    coverPhoto: {
      type: String,
      default: null
    },
    followers: {
      type: Number,
      default: 0
    },
    following: {
      type: Number,
      default: 0
    },
    bio: {
      type: String,
      default: null,
    },
    location: {
      type: Object,
      default: null
    },
    phone: {
      type: String,
      default: null,
    },
    company: {
      type: String,
      default: null,
    },
    services: {
      type: [String],
      default: null
    },
    verified: {
      type: Boolean,
      default: false
    }
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
  activeStatus: {
    type: Boolean,
    default: true
  },
  kycStatus: {
    type: String,
    required: false,
    default: 'not-verified'
  },
  preferences: {
    categories: [String],
    notifications: {
      email: { type: Boolean, default: true },
      inApp: { type: Boolean, default: false },
    }
  }
}, {
  timestamps: true
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