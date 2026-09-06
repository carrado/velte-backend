import express from 'express';
import { subscribe, unsubscribe } from '../controllers/push/push.controller.js';
import { resolveActor } from '../middleware/resolveActor.js';

const router = express.Router();

// Either account kind (2026-09-05) — buyers get their own alerts now (a
// buyer request being accepted, say), so buyers have to be able to register
// a device. See notifications.routes.js for the same change and reasoning.
router.use(resolveActor);

router.post('/subscribe', subscribe);
router.post('/unsubscribe', unsubscribe);

export default router;
