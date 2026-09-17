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
import { updateProfile } from '../controllers/auth/updateProfile.js';
import { passwordResetOTP, resendOTP } from '../controllers/auth/resend-verification.js';
import { requestPasswordChange, confirmPasswordChange } from '../controllers/auth/changePassword.js';
import { updateSectors, updateFoodSettings } from '../controllers/auth/sectors.js';

const router = express.Router();

// Define routes and map to controller functions
router.post('/register', register);
router.post('/login', login);
router.post("/verify", verifyEmail);
router.post("/resend-verification", resendOTP)
router.post("/getPasswordOTP", passwordResetOTP)
router.post("/logout", logout)
router.delete("/delete-account", verifyAuth, deleteAccount)
router.put("/profile", verifyAuth, updateProfile);
router.post("/verify-reset-otp", verifyPasswordOTP)
router.post("/reset-password", resetPassword);
// NOT verifyAuth (2026-09-16) — "the single auth API": this now reads BOTH
// the vendor and buyer cookies itself and returns whichever exist together
// (see userProfile.js's own header). The strict "vendor required or 401"
// behavior callers like the dashboard still need lives in the FRONTEND's
// own requireAuth() gate (src/app/api/auth/me/route.ts in the velte repo),
// not here — this route has to stay permissive so the same endpoint also
// serves lenient callers (src/app/api/auth/whoami/route.ts).
router.get("/me", profile)

// Account settings — password change (two-step)
router.post("/change-password/request", verifyAuth, requestPasswordChange);
router.post("/change-password/confirm", verifyAuth, confirmPasswordChange);

// Vendor sectors
router.patch("/sectors", verifyAuth, updateSectors);

// Food vendor settings
router.put("/settings/food", verifyAuth, updateFoodSettings);

export default router;