import express from 'express';
import { getMyReferrals, validateReferralCode } from '../controllers/referrals/referral.controller.js';
import { verifyAuth } from '../middleware/auth.js';

const router = express.Router();

router.get('/me', verifyAuth, getMyReferrals);
// Public — the signup page calls this before the buyer has an account.
router.get('/validate/:code', validateReferralCode);

export default router;
