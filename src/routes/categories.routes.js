import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { listCategories } from '../controllers/categories/category.controller.js';

const router = express.Router();

router.use(verifyAuth);

router.get('/', listCategories);

export default router;
