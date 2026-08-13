import jwt from "jsonwebtoken";
import Buyer from "../../models/Buyer.model.js";
import { sendSms } from "../../services/sendchamp.service.js";
import { AppError } from "../../middleware/errorHandler.js";

// Matches the existing email-OTP TTL used elsewhere in this repo
// (Users.js's emailOtp/changePasswordOtp) for consistency.
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
// Unlike the Buyer Requests confirmation SMS (spec §29, "SMS failure must
// not roll back the primary action"), a failed send here DOES surface as an
// error — the OTP isn't a nice-to-have confirmation, it's the one thing the
// buyer is blocked on. Swallowing the failure would leave them staring at a
// "check your phone" screen for a code that never arrives.
export async function requestOtp(req, res, next) {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== "string" || phone.trim().length < 7) {
      return next(new AppError("A valid phone number is required", 400));
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

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

// POST /api/buyer-auth/verify-otp — { phone, otp, username, name, location? }
// Verifies the code, marks the buyer verified, issues the session cookie.
// `location` stays optional per spec §3/§63.3's "do not ask for unnecessary
// onboarding information" — but `username` and `name` are the buyer's real
// identity (two buyers can't share a username) and are required the first
// time a buyer verifies; a buyer who already has them can leave either out
// on later verifications and keep the existing values.
export async function verifyOtp(req, res, next) {
  try {
    const { phone, otp, username, name, location } = req.body;
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

    if (!buyer.name && (typeof name !== "string" || !name.trim())) {
      return next(new AppError("Please tell us your name.", 400));
    }
    if (!buyer.username && !username) {
      return next(new AppError("Please choose a username.", 400));
    }
    if (username) {
      const normalized = String(username).trim().toLowerCase();
      if (!USERNAME_RE.test(normalized)) {
        return next(
          new AppError(
            "Username must be 3-20 characters — letters, numbers and underscores only.",
            400,
          ),
        );
      }
      buyer.username = normalized;
    }

    buyer.phoneVerified = true;
    buyer.phoneOtp = undefined;
    if (name && typeof name === "string" && name.trim()) {
      buyer.name = name.trim();
    }
    if (
      location &&
      typeof location.lat === "number" &&
      typeof location.lng === "number"
    ) {
      buyer.location = { type: "Point", coordinates: [location.lng, location.lat] };
    }
    try {
      await buyer.save();
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.username) {
        return next(
          new AppError("That username is already taken. Try another.", 409),
        );
      }
      throw err;
    }

    // Separate cookie name from the vendor's `auth_token` (not just a
    // separate `type` claim) so a buyer and vendor session can coexist in
    // the same browser without one overwriting the other. The `type: "buyer"`
    // claim is still checked in verifyBuyerAuth as a second, independent
    // guard against a token ever being misread as the wrong kind.
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
