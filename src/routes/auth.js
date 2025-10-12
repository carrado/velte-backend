import express from 'express';
import {
  register,
  login
} from '../controllers/auth.js';
import { verifyEmail } from '../controllers/verifyEmail.js';

const router = express.Router();

// Define routes and map to controller functions
router.post('/register', register);
router.post('/login', login);
router.post("/verify", verifyEmail);

export default router;