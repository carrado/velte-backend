import jwt from "jsonwebtoken";
import Buyer from "../../models/Buyer.model.js";
// Cross-collection uniqueness only — a buyer and a vendor can never share a
// phone number (see auth.js's register for the mirror check on the vendor
// side).
import User from "../../models/Users.js";
import { sendSms } from "../../services/sendchamp.service.js";
import { AppError } from "../../middleware/errorHandler.js";

const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL = "7d"; // matches the vendor auth_token lifetime

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
// Upserts a Buyer by phone, generates a fresh code, sends it via Sendchamp.
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

    // A phone that already belongs to a vendor account can never become a
    // buyer too (mirrors auth.js's register phone check the other way
    // round). A returning buyer re-requesting their OWN code is unaffected.
    const phoneOwnedByVendor = await User.exists({ phone: phone.trim() });
    if (phoneOwnedByVendor) {
      return next(
        new AppError(
          "An account with this phone number already exists.",
          409,
        ),
      );
    }

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    const buyer = await Buyer.findOneAndUpdate(
      { phone: phone.trim() },
      { $set: { phoneOtp: { code, expiresAt } } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await sendSms(
      buyer.phone,
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
// Verifies the code, marks the buyer verified, issues the session cookie.
// This is the ONLY thing "identifying" a buyer does — proving they own a
// phone number, nothing more. No name/email/password is ever collected
// here; a buyer's name (when one is needed, e.g. for a Buyer Request) is
// asked for conversationally by the AI and passed straight into that
// specific request instead (see createBuyerRequestTool.ts).
export async function verifyOtp(req, res, next) {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
      return next(new AppError("Phone and code are required", 400));
    }

    const buyer = await Buyer.findOne({ phone: phone.trim() });
    if (!buyer) {
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

    buyer.phoneVerified = true;
    buyer.phoneOtp = undefined;
    await buyer.save();

    // Separate cookie name from the vendor's `auth_token` so a buyer and
    // vendor session can coexist in the same browser without one
    // overwriting the other. The `type: "buyer"` claim is a second,
    // independent guard against a token ever being misread as the wrong kind.
    const token = jwt.sign(
      { buyerId: buyer._id, type: "buyer" },
      process.env.JWT_SECRET,
      { expiresIn: SESSION_TTL },
    );
    res.cookie("buyer_auth_token", token, cookieOptions());

    res.status(200).json({ success: true, data: { buyer } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// GET /api/buyer-auth/me — lets the frontend recognize an already-verified
// phone on a fresh page load (skip straight past the phone/OTP form) without
// exposing anything beyond that.
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
