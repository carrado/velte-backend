import express from 'express';
import {
  register,
  login
} from '../controllers/auth.js';
import { verifyEmail } from '../controllers/verifyEmail.js';
import { verifyAuth } from "../middleware/auth.js";
import { profile } from '../controllers/userProfile.js';

const router = express.Router();

// Define routes and map to controller functions
router.post('/register', register);
router.post('/login', login);
router.post("/verify", verifyEmail);
router.get("/me", verifyAuth, profile)

export default router;