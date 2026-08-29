import jwt from "jsonwebtoken";
import Buyer from "../../models/Buyer.model.js";
import PhoneVerification from "../../models/PhoneVerification.model.js";
// Cross-collection uniqueness only — a buyer and a vendor can never share a
// phone number (see auth.js's register for the mirror check on the vendor
// side).
import User from "../../models/Users.js";
import { sendSms } from "../../services/sendchamp.service.js";
import { AppError } from "../../middleware/errorHandler.js";

const OTP_TTL_MS = 10 * 60 * 1000;

// How long a proven phone number stays usable for. Long enough to finish the
// Buyer Request it was verified for (the buyer types a code, then Velte
// creates the request moments later), short enough that a token lifted off a
// shared machine is worthless by the time anyone finds it. Deliberately NOT
// the 7 days a session gets — this proves one fact for one action, it is not
// a login.
const PHONE_TOKEN_TTL = "30m";

// ── What a phone number is, and is not (2026-08-27) ──────────────────────
//
// Per explicit product decision: verifying a phone number does NOT create an
// account. `buyer_auth_token` now means exactly one thing — signed in with
// Google (see firebaseAuth.controller.js) — and this file no longer issues
// one. Two consequences shape everything below:
//
//   ANONYMOUS: the code lives in PhoneVerification (its own short-lived
//   collection), and verifying returns a `phoneToken` — a short JWT that
//   proves ONE number for ONE Buyer Request. No Buyer document is created,
//   no session cookie is set, and nothing about this person is retained
//   afterwards beyond what the request itself snapshots (BuyerRequest
//   carries buyerName/buyerPhone on the request, which is where a buyer's
//   details have always belonged).
//
//   SIGNED IN: the code lives on their own Buyer document, and verifying
//   attaches the number to their account — because for them, retaining it IS
//   the point: the next Buyer Request offers it back instead of asking again.
//
// Before this, both paths ran through a Buyer upserted by phone, which is
// what made every verification quietly mint a half-account.

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000);
}

function cookieOptions() {
  const isProd =
    process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  };
}

// POST /api/buyer-auth/request-otp — { phone }
// Generates a fresh code and sends it via Sendchamp.
//
// Unlike the Buyer Requests confirmation SMS (a failed send there must not
// roll back the request itself), a failed send HERE does surface as an
// error — the OTP isn't a nice-to-have confirmation, it's the one thing the
// buyer is blocked on.
export async function requestOtp(req, res, next) {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== "string" || phone.trim().length < 7) {
      return next(new AppError("A valid phone number is required", 400));
    }

    const trimmed = phone.trim();

    // A phone that already belongs to a vendor account can never be verified
    // as a buyer's (mirrors auth.js's register phone check the other way
    // round).
    const phoneOwnedByVendor = await User.exists({ phone: trimmed });
    if (phoneOwnedByVendor) {
      return next(
        new AppError("An account with this phone number already exists.", 409),
      );
    }

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    if (req.buyer?.buyerId) {
      // Signed in — attaching a number to an existing account. The number is
      // held in `pendingPhone` until proven, so an unverified one never
      // becomes the account's contact (a vendor would otherwise reply on
      // WhatsApp to a number nobody has proven they own).
      //
      // Refused if the number is already verified on a DIFFERENT account:
      // silently folding two accounts together would move one person's
      // conversation history onto another's, and nothing here can know they
      // are the same person.
      const owner = await Buyer.findOne({ phone: trimmed }).select("_id");
      if (owner && String(owner._id) !== String(req.buyer.buyerId)) {
        return next(
          new AppError(
            "That number is already verified on another account.",
            409,
          ),
        );
      }
      await Buyer.findByIdAndUpdate(req.buyer.buyerId, {
        $set: { pendingPhone: trimmed, phoneOtp: { code, expiresAt } },
      });
    } else {
      // Anonymous — nothing about this person is stored beyond a code and an
      // expiry. Upserted by phone so re-requesting replaces the old code
      // rather than leaving two live.
      await PhoneVerification.findOneAndUpdate(
        { phone: trimmed },
        { $set: { code, expiresAt } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }

    await sendSms(
      trimmed,
      `Your Velte verification code is ${code}. It expires in 10 minutes.`,
    );

    res.status(200).json({
      success: true,
      data: { message: "Verification code sent." },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// POST /api/buyer-auth/verify-otp — { phone, otp }
//
// Two outcomes, and neither is a login:
//   anonymous → { phoneToken } proving this number for one Buyer Request
//   signed in → { buyer } with the number now attached to their account
//
// This endpoint deliberately no longer issues `buyer_auth_token`. A phone
// number is not an identity on Velte; a Google account is.
export async function verifyOtp(req, res, next) {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
      return next(new AppError("Phone and code are required", 400));
    }
    const trimmed = phone.trim();

    // ── Signed in: attach the number to the account ─────────────────────
    if (req.buyer?.buyerId) {
      const buyer = await Buyer.findById(req.buyer.buyerId);
      // Guards against a code issued for one number being used to verify
      // another — the code sits on the account, so without this the number
      // in the request body would be taken on trust.
      if (!buyer || buyer.pendingPhone !== trimmed) {
        return next(
          new AppError("No verification request found for this number", 404),
        );
      }
      if (!buyer.phoneOtp?.code || buyer.phoneOtp.code !== Number(otp)) {
        return next(new AppError("Invalid code", 400));
      }
      if (!buyer.phoneOtp.expiresAt || buyer.phoneOtp.expiresAt < new Date()) {
        return next(new AppError("Code has expired. Request a new one.", 400));
      }

      // Proven — so it becomes the account's real number. This is the line
      // that makes it RETAINED, so the next Buyer Request can offer it back
      // instead of asking again.
      buyer.phone = buyer.pendingPhone;
      buyer.pendingPhone = null;
      buyer.phoneVerified = true;
      buyer.phoneOtp = undefined;
      await buyer.save();

      return res.status(200).json({ success: true, data: { buyer } });
    }

    // ── Anonymous: prove the number, create nothing ─────────────────────
    const pending = await PhoneVerification.findOne({ phone: trimmed });
    if (!pending) {
      return next(
        new AppError("No verification request found for this number", 404),
      );
    }
    if (pending.code !== Number(otp)) {
      return next(new AppError("Invalid code", 400));
    }
    if (pending.expiresAt < new Date()) {
      return next(new AppError("Code has expired. Request a new one.", 400));
    }

    // Single-use: deleted the moment it's spent, so a code can't be replayed
    // and the TTL sweep has nothing left to do.
    await PhoneVerification.deleteOne({ _id: pending._id });

    // `type: "phone_verified"` is a second, independent guard against this
    // ever being read as a session — buyerAuth.js checks for `type: "buyer"`
    // and will reject this token outright, which is exactly what should
    // happen if one is ever presented as a cookie.
    const phoneToken = jwt.sign(
      { phone: trimmed, type: "phone_verified" },
      process.env.JWT_SECRET,
      { expiresIn: PHONE_TOKEN_TTL },
    );

    res.status(200).json({ success: true, data: { phoneToken } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// GET /api/buyer-auth/me — the signed-in buyer, for the frontend to render
// its own signed-in state on load.
export async function me(req, res, next) {
  try {
    const buyer = await Buyer.findById(req.buyer.buyerId);
    if (!buyer) return next(new AppError("Buyer not found", 404));
    res.status(200).json({ success: true, data: { buyer } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

export async function logout(_req, res) {
  res.clearCookie("buyer_auth_token", cookieOptions());
  res.status(200).json({ success: true, data: { message: "Logged out." } });
}
