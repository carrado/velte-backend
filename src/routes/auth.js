import express from 'express';
import {
  register,
  login,
  logout,
  verifyEmail,
  deleteAccount,
  verifyPasswordOTP,
  resetPassword
} from '../controllers/auth/auth.js';
import { verifyAuth } from "../middleware/auth.js";
import { profile } from '../controllers/userProfile.js';
import { passwordResetOTP, resendOTP } from '../controllers/auth/resend-verification.js';

const router = express.Router();

// Define routes and map to controller functions
router.post('/register', register);
router.post('/login', login);
router.post("/verify", verifyEmail);
router.post("/resend-verification", resendOTP)
router.post("/getPasswordOTP", passwordResetOTP)
router.post("/logout", logout)
router.delete("/delete-account", verifyAuth, deleteAccount)
// router.put("/profile", verifyAuth, updateProfile)
router.post("/verify-reset-otp", verifyPasswordOTP)
router.post("/reset-password", resetPassword);
router.get("/me", verifyAuth, profile)

export default router;