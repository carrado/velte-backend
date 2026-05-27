import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  toggleAvailability,
  restockProduct,
  changePrice,
  resetDailyLimits,
} from '../controllers/products/product.controller.js';

const router = express.Router();

router.use(verifyAuth);

// Internal cron endpoint — must come before /:id routes
router.post('/reset-daily-limits', resetDailyLimits);

router.get('/',    getProducts);
router.post('/',   createProduct);
router.get('/:id', getProduct);
router.put('/:id', updateProduct);
router.delete('/:id', deleteProduct);

router.patch('/:id/availability', toggleAvailability);
router.post('/:id/restock',       restockProduct);
router.patch('/:id/price',        changePrice);

export default router;
