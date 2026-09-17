import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  // Buyer._id or User._id, decided by ownerType below.
  //
  // The `ref: 'User'` that used to sit here was not just decoration — it was
  // the assumption that only vendors ever get notified, and it is why buyers
  // had no in-app notifications at all (2026-09-05). A buyer-owned
  // notification (buyer-request, buyer-follow, ...) needs to reach the Buyer
  // collection just as readily as a vendor one reaches User — one ref cannot
  // express "either collection", so this is dropped rather than switched.
  //
  // The FIELD NAME stays `userId`. Renaming it would touch every existing
  // row, the controller, and the dashboard's own reads, to say something the
  // adjacent `ownerType` already says.
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  // Defaults to "vendor" so every row written before this — all of them —
  // reads back correctly with no migration.
  ownerType: {
    type: String,
    enum: ['buyer', 'vendor'],
    default: 'vendor',
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  body: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['new-order', 'new-message', 'new-lead', 'expired-product', 'payment', 'wallet', 'referral', 'system', 'buyer-request', 'buyer-follow', 'shopping-list'],
    default: 'system',
  },
  url: {
    type: String,
    default: null,
  },
  tag: {
    type: String,
    default: null,
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
}, {
  timestamps: true,
});

// For efficiently fetching unread count and paginated list per owner.
// ownerType is part of the key: a Buyer._id and a User._id are both
// ObjectIds and could in principle collide, and reading one account's
// notifications into the other's bell is not a mistake worth risking.
notificationSchema.index({ userId: 1, ownerType: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, ownerType: 1, isRead: 1 });

export default mongoose.model('Notification', notificationSchema);
