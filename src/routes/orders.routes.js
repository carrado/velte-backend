import express from 'express';
import rateLimit from 'express-rate-limit';
import { verifyAuth } from '../middleware/auth.js';
import {
  createOrder,
  getOrders,
  getOrder,
  getOrderStats,
  updateOrderStatus,
} from '../controllers/orders/order.controller.js';

const router = express.Router();

router.use(verifyAuth);

// Per-vendor rate limiting (verifyAuth has already set req.user). Falls back to IP
// if the key is somehow missing. orders-api.md → "Abuse & hardening".
const perVendorKey = (req) => req.user?.userId || req.ip;

const rateLimited = ({ windowMs, max }) =>
  rateLimit({
    windowMs,
    max,
    keyGenerator: perVendorKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' } },
  });

/** List/search — fairly chatty (debounced search, pagination). */
const listLimiter = rateLimited({ windowMs: 60 * 1000, max: 60 });
/** Status mutations — stricter; these move fulfilment state. */
const statusLimiter = rateLimited({ windowMs: 60 * 1000, max: 20 });

router.get('/', listLimiter, getOrders);
router.post('/', createOrder);
router.get('/stats', getOrderStats); // must precede '/:id' so 'stats' isn't read as an id
router.get('/:id', getOrder);
router.patch('/:id/status', statusLimiter, updateOrderStatus);

export default router;
