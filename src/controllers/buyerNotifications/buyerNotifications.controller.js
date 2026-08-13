import BuyerNotification from "../../models/BuyerNotification.model.js";
import { AppError } from "../../middleware/errorHandler.js";

const PAGE_SIZE = 20;

function toClientShape(n) {
  return {
    id: n._id.toString(),
    type: n.type,
    title: n.title,
    body: n.body,
    read: n.isRead,
    href: n.url ?? null,
    createdAt:
      n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
  };
}

// ── GET /api/buyer-notifications ─────────────────────────────────────────
export async function getMyNotifications(req, res, next) {
  try {
    const buyerId = req.buyer.buyerId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const skip = (page - 1) * PAGE_SIZE;

    const [raw, unreadCount] = await Promise.all([
      BuyerNotification.find({ buyerId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .lean(),
      BuyerNotification.countDocuments({ buyerId, isRead: false }),
    ]);

    res.status(200).json({
      success: true,
      data: { notifications: raw.map(toClientShape), unreadCount, page },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── PATCH /api/buyer-notifications/:id/read ──────────────────────────────
export async function markRead(req, res, next) {
  try {
    const buyerId = req.buyer.buyerId;
    const notification = await BuyerNotification.findOneAndUpdate(
      { _id: req.params.id, buyerId },
      { isRead: true },
      { new: true },
    );
    if (!notification) {
      return next(new AppError("Notification not found.", 404));
    }
    res
      .status(200)
      .json({ success: true, data: { notification: toClientShape(notification) } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── PATCH /api/buyer-notifications/read-all ──────────────────────────────
export async function markAllRead(req, res, next) {
  try {
    const buyerId = req.buyer.buyerId;
    await BuyerNotification.updateMany(
      { buyerId, isRead: false },
      { isRead: true },
    );
    res.status(200).json({ success: true, data: { message: "All marked read." } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
