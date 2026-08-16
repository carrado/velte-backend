import jwt from "jsonwebtoken";
import Buyer from "../../models/Buyer.model.js";
// Cross-model uniqueness only — a buyer and a vendor can never share an
// email or phone number (see auth.js's register for the mirror check on
// the vendor side, and login below, which is now the ONLY login path for
// buyers too — see that file's own comment on why).
import User from "../../models/Users.js";
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

    // Checked here, before an SMS is spent, not at verify-otp time — a
    // phone that already belongs to a vendor account can never become a
    // buyer account too (mirrors auth.js's register phone check the other
    // way round). A returning buyer re-requesting their OWN code is
    // unaffected: this only ever matches the VENDOR collection.
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

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

// Auto-generates a placeholder username from the buyer's own phone number
// (e.g. "buyer_012345") — 2026-08-13 registration-friction fix: username
// used to be a REQUIRED field on first verification (two buyers can't share
// one, so *some* value has to exist), which meant "post a request" and
// "save an item" both forced a buyer through a username-picking form before
// either could complete. Now it's generated silently so verifyOtp never
// blocks on it; the buyer can still pick a real one later via PATCH /me
// (Profile page), same "defer it, don't gate on it" treatment as `name`.
async function generateUsername(phone) {
  const digits = String(phone).replace(/\D/g, "").slice(-6) || "0000";
  const base = `buyer_${digits}`;
  if (!(await Buyer.exists({ username: base }))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    // eslint-disable-next-line no-await-in-loop -- small, bounded collision
    // retry (mirrors store.controller.js's own getOrCreateStore handle loop)
    if (!(await Buyer.exists({ username: candidate }))) return candidate;
  }
  // Astronomically unlikely (1000 collisions on the same 6 digits) — fall
  // back to something guaranteed-unique rather than loop forever.
  return `buyer_${digits}_${Date.now().toString(36)}`;
}

// POST /api/buyer-auth/verify-otp — { phone, otp, email?, name?, password?, location? }
// Verifies the code, marks the buyer verified, issues the session cookie.
// 2026-08-15, REVERTED back to lightweight per the AI-agent pivot: phone +
// OTP is enough to create a real buyer account on its own again — this is
// now the tool the AI's createBuyerRequest flow calls INLINE, mid-chat, the
// instant it needs to identify a buyer to notify later (see
// createBuyerRequestTool.ts). Forcing email+password in that moment would
// break the "still talking to Velte, not filling out a form" feel that's
// the whole point of that flow. `email`/`password` stay accepted and
// validated/uniqueness-checked when the buyer DOES provide them (the
// unified /auth/signup buyer form still collects both, upgrading this same
// account to full email/username+password login) — they're just no longer
// required here. `name`/`location` were already optional. `username` is
// still never buyer-supplied — see generateUsername() above; it, `phone`,
// and `email` (when present) are all enforced unique, `email`/`phone`
// across BOTH collections (a buyer and a vendor can never share either).
export async function verifyOtp(req, res, next) {
  try {
    const { phone, otp, email, name, password, location } = req.body;
    if (!phone || !otp) {
      return next(new AppError("Phone and code are required", 400));
    }
    let normalizedEmail = null;
    if (email !== undefined && email !== null && email !== "") {
      if (typeof email !== "string" || !email.includes("@")) {
        return next(new AppError("A valid email address is required", 400));
      }
      normalizedEmail = email.trim().toLowerCase();
    }
    if (password !== undefined && password !== null && password !== "") {
      if (typeof password !== "string" || password.length < 8) {
        return next(
          new AppError("Password must be at least 8 characters", 400),
        );
      }
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

    // Cross-collection email check — Buyer's own schema-level unique index
    // only ever catches a collision with ANOTHER buyer (still checked below,
    // via the 11000 handler), not with a vendor. Only runs when an email was
    // actually supplied this call.
    if (normalizedEmail) {
      const emailOwnedByVendor = await User.exists({ email: normalizedEmail });
      if (emailOwnedByVendor) {
        return next(
          new AppError("An account with this email already exists.", 409),
        );
      }
    }

    if (!buyer.username) {
      buyer.username = await generateUsername(buyer.phone);
    }

    buyer.phoneVerified = true;
    buyer.phoneOtp = undefined;
    if (normalizedEmail) buyer.email = normalizedEmail;
    if (password) buyer.password = password;
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
      if (err.code === 11000 && err.keyPattern?.email) {
        return next(
          new AppError("An account with this email already exists.", 409),
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

// Buyer login used to be its own POST /login here (phone + password, no
// OTP). Removed 2026-08-15 — it's now handled entirely by the UNIFIED
// login in auth.js's `login`, which checks the vendor collection first and
// falls back to this one (by email or username) so there's exactly one
// login endpoint, and one login screen, for both account types. See that
// file's own comment for the full reasoning.

export async function me(req, res, next) {
  try {
    const buyer = await Buyer.findById(req.buyer.buyerId);
    if (!buyer) return next(new AppError("Buyer not found", 404));
    res.status(200).json({ success: true, data: { buyer } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// PATCH /api/buyer-auth/me — { name?, username?, location? }
// 2026-08-13 — the progressive-profile counterpart to verifyOtp no longer
// collecting name/username upfront: a verified buyer can fill either in
// later (the post-verify "what should we call you?" step, or the Profile
// page's own edit-in-place rows) without it ever having blocked their
// original request/save. Mirrors auth.js's vendor `PUT /profile` shape.
export async function updateMe(req, res, next) {
  try {
    const { name, username, location } = req.body;
    const buyer = await Buyer.findById(req.buyer.buyerId);
    if (!buyer) return next(new AppError("Buyer not found", 404));

    if (typeof name === "string") {
      const trimmed = name.trim();
      if (!trimmed) return next(new AppError("Name can't be empty.", 400));
      buyer.name = trimmed;
    }
    if (typeof username === "string") {
      const normalized = username.trim().toLowerCase();
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

    res.status(200).json({ success: true, data: { buyer } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

export async function logout(_req, res) {
  res.clearCookie("buyer_auth_token", cookieOptions());
  res.status(200).json({ success: true, data: { message: "Logged out." } });
}
