import express from 'express';
import { subscribe, unsubscribe } from '../controllers/push/push.controller.js';
import { verifyAuth } from '../middleware/auth.js';

const router = express.Router();

router.post('/subscribe', verifyAuth, subscribe);
router.post('/unsubscribe', verifyAuth, unsubscribe);

export default router;
