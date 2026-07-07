import User from '../../models/Users.js';
import Referral from '../../models/Referral.model.js';
import { AppError } from '../../middleware/errorHandler.js';
import { generateUniqueReferralCode } from '../../utils/referralCode.js';

// ── GET /api/referrals/me ────────────────────────────────────────────────────
// The signed-in vendor's own code, stats, and recent referral history.

export async function getMyReferrals(req, res, next) {
  try {
    const user = await User.findById(req.user.userId).select('referralCode');
    if (!user) throw new AppError('User not found.', 404);

    // Backfill for any vendor who signed up before this feature existed —
    // everyone should have a code the moment they open this page, not just
    // vendors who signed up after this shipped.
    if (!user.referralCode) {
      user.referralCode = await generateUniqueReferralCode(User);
      await user.save();
    }

    const [statsAgg, recent] = await Promise.all([
      Referral.aggregate([
        { $match: { referrerId: user._id } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            bonusKobo: { $sum: '$bonusKobo' },
          },
        },
      ]),
      Referral.find({ referrerId: user._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('refereeId', 'name company.name')
        .lean(),
    ]);

    const byStatus = Object.fromEntries(statsAgg.map((s) => [s._id, s]));
    const pending = byStatus.pending?.count ?? 0;
    const credited = byStatus.credited?.count ?? 0;
    const totalEarnedKobo = byStatus.credited?.bonusKobo ?? 0;

    res.json({
      success: true,
      data: {
        code: user.referralCode,
        stats: {
          totalReferred: pending + credited,
          pending,
          credited,
          totalEarnedKobo,
        },
        referrals: recent.map((r) => ({
          id: r._id.toString(),
          refereeName: r.refereeId?.company?.name || r.refereeId?.name || 'A new vendor',
          status: r.status,
          bonusKobo: r.bonusKobo,
          createdAt: r.createdAt,
          creditedAt: r.creditedAt,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/referrals/validate/:code ────────────────────────────────────────
// Public, no auth — lets the signup page show "You're signing up via
// <BusinessName>'s invite" instead of a bare code, and confirm a
// manually-typed code is real before the buyer submits the form.

export async function validateReferralCode(req, res, next) {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) {
      return res.json({ success: true, data: { valid: false } });
    }

    const referrer = await User.findOne({ referralCode: code }).select('name company.name');
    if (!referrer) {
      return res.json({ success: true, data: { valid: false } });
    }

    res.json({
      success: true,
      data: {
        valid: true,
        businessName: referrer.company?.name || referrer.name,
      },
    });
  } catch (err) {
    next(err);
  }
}
