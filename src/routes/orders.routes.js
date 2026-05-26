import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import {
  createOrder,
  getOrders,
  getOrder,
  updateOrderStatus,
} from '../controllers/orders/order.controller.js';

const router = express.Router();

router.use(verifyAuth);

router.get('/', getOrders);
router.post('/', createOrder);
router.get('/:id', getOrder);
router.patch('/:id/status', updateOrderStatus);

export default router;
