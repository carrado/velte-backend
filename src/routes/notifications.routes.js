import express from 'express';
import {
  getNotifications,
  markRead,
  markAllRead,
  deleteNotification,
} from '../controllers/notifications/notification.controller.js';
import { verifyAuth } from '../middleware/auth.js';

const router = express.Router();

router.get('/', verifyAuth, getNotifications);
router.patch('/:id/read', verifyAuth, markRead);
router.patch('/read-all', verifyAuth, markAllRead);
router.delete('/:id', verifyAuth, deleteNotification);

export default router;
