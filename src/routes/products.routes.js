import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import {
  createProduct,
  getProducts,
  getProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/products/product.controller.js';

const router = express.Router();

router.use(verifyAuth);

router.get('/', getProducts);
router.post('/', createProduct);
router.get('/:id', getProduct);
router.put('/:id', updateProduct);
router.delete('/:id', deleteProduct);

export default router;
