import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import {
  listModifierOptions,
  createModifierOption,
  updateModifierOption,
  deleteModifierOption,
} from '../controllers/modifiers/modifier.controller.js';

const router = express.Router();

router.use(verifyAuth);

router.get('/',     listModifierOptions);
router.post('/',    createModifierOption);
router.put('/:id',  updateModifierOption);
router.delete('/:id', deleteModifierOption);

export default router;
