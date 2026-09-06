import express from 'express';
import {
  getNotifications,
  markRead,
  markAllRead,
  deleteNotification,
} from '../controllers/notifications/notification.controller.js';
import { resolveActor } from '../middleware/resolveActor.js';

const router = express.Router();

// resolveActor, not verifyAuth (2026-09-05). Notifications used to be a
// vendor-only idea, so the vendor guard was the right one; buyers have them
// now too (a buyer request being accepted, say). resolveActor accepts either
// cookie and prefers the buyer's when both are present, which is correct
// here for the same reason it is everywhere else: someone reading
// notifications on /chat is acting as a buyer, and a vendor in their
// dashboard carries no buyer cookie at all.
//
// It never 401s on its own — the controller answers that, so an anonymous
// caller gets a clean "Not authenticated" rather than a middleware throw.
router.use(resolveActor);

router.get('/', getNotifications);
router.patch('/:id/read', markRead);
router.patch('/read-all', markAllRead);
router.delete('/:id', deleteNotification);

export default router;
