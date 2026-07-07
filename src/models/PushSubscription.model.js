import mongoose from 'mongoose';

const pushSubscriptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  endpoint: {
    type: String,
    required: true,
    unique: true,
  },
  p256dh: {
    type: String,
    required: true,
  },
  auth: {
    type: String,
    required: true,
  },
  // Consecutive 401/403 (VAPID-mismatch) send failures. A one-off server misconfig
  // resets this on the next good send; a genuinely-bad subscription climbs until it
  // crosses the prune threshold. Never deleted on a single auth failure.
  failureCount: {
    type: Number,
    default: 0,
  },
  lastFailureAt: {
    type: Date,
  },
  // Bumped on every successful send AND every (re)subscribe. Used to evict the
  // oldest orphan rows left behind by clear-site-data → reinstall cycles, which
  // drop the browser subscription but can leave a stale row here.
  lastSeenAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

export default mongoose.model('PushSubscription', pushSubscriptionSchema);
