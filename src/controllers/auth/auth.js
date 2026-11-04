import jwt from "jsonwebtoken";
import User from "../../models/Users.js";
// Cross-model uniqueness + the unified login's buyer fallback — see
// register()'s and login()'s own comments below. Buyer.model.js's own
// comment has the mirror check on the buyer-signup side.
import Buyer from "../../models/Buyer.model.js";
import { sendVerificationEmail } from "../../helpers/emailSender.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  sessionCookieOptions,
  clearSessionCookieOptions,
} from "../../utils/authCookies.js";
import {
  prepareReferralForSignup,
  recordPendingReferral,
  creditPendingReferral,
} from "../../services/referral.service.js";
import { getOrCreateStore } from "../store/store.controller.js";
import { embedAndSaveStore } from "../../services/embedding.service.js";
import { sectorLabel, isKnownSector } from "../../utils/sectorLabels.js";
import { geocodeVendorAddressGoogle } from "../../services/geocode.service.js";
import {
  findBuyerByEmail,
  linkVerifiedAccounts,
} from "../../services/identityLink.service.js";

const MAX_SECTORS = 5;


export const register = async (req, res, next) => {
  try {
    const {
      name,
      email,
      password,
      businessName,
      services,
      country,
      address,
      username,
      agreeToTerms,
      phone,
      state,
      sectors,
      description,
      location,
      referralCode,
    } = req.body;

    // 🔹 Validate required fields
    //
    // `phone` is required as of 2026-09-27, per explicit product direction.
    // It was optional before — `phone: phone || null` below — which left
    // vendor accounts with no number at all. That was survivable while a
    // vendor only ever REACHED OUT to buyers; it stopped being survivable
    // once a vendor could post their own Buyer Request, because the number
    // that request is answered on is this one (it is also what Store.whatsapp
    // is populated from, see below).
    //
    // The check that it is UNIQUE already exists and is not new here — see
    // the block further down, which also rejects a number already on a Buyer.
    if (!name || !email || !password || !businessName || !username || !phone) {
      throw new AppError(
        "Name, email, password, business name, username and phone number are required fields",
        400,
      );
    }

    if (
      !Array.isArray(sectors) ||
      sectors.length === 0 ||
      sectors.length > MAX_SECTORS ||
      !sectors.every(isKnownSector)
    ) {
      throw new AppError(
        `sectors must be an array of 1-${MAX_SECTORS} known sector values`,
        400,
      );
    }

    let geo;
    if (location !== undefined && location !== null) {
      const { lat, lng } = location;
      if (
        typeof lat !== "number" ||
        typeof lng !== "number" ||
        lat < -90 || lat > 90 ||
        lng < -180 || lng > 180
      ) {
        throw new AppError("location must be { lat, lng } within valid range", 400);
      }
      geo = { type: "Point", coordinates: [lng, lat] };
    } else if (address || state) {
      // No coords from the browser (vendor typed their address instead of
      // tapping "Use my current location") — without this, geo is simply
      // never set, and staffly-ai-backend's rankCandidates silently drops
      // any vendor with no geo.coordinates from EVERY location-scoped search
      // tier (local/nearby/state), leaving them reachable only by a
      // nationwide fallback search. Best-effort: a vendor who fails to
      // geocode here still registers exactly as before this fix existed.
      const coords = await geocodeVendorAddressGoogle(address, state);
      if (coords) geo = { type: "Point", coordinates: [coords.lng, coords.lat] };
    }

    // 🔹 Check if user already exists
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      if (existingUser.accountVerified) {
        // ✅ User already verified — block registration
        throw new AppError("User with this email already exists and is verified.", 400);
      } else {
        // 🔁 User exists but not verified — resend OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        existingUser.emailOtp = {
          code: otp,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        };

        await existingUser.save();

        await sendVerificationEmail(existingUser.email, existingUser.name, otp);

        return res.status(200).json({
          success: true,
          message:
            "An account with this email already exists but hasn’t been verified yet. A new verification code has been sent to your email — please verify your account to continue.",
        });
      }
    }

    // A phone number identifies a real person the same way an email does —
    // two accounts sharing one lets either side impersonate/contact-hijack
    // the other's buyers. Checked here (not before the existingUser block
    // above) on purpose: a vendor re-submitting their own pending/
    // unverified signup already returns early above with the SAME phone
    // they entered before — checking any earlier would wrongly reject
    // their own resend as "taken." Also a backstop below the app layer,
    // not instead of one — see Users.js's partial unique index. Now also
    // checks the Buyer collection (same reasoning as the email check above).
    if (phone) {
      const [phoneTaken, phoneOwnedByBuyer] = await Promise.all([
        User.findOne({ phone }),
        Buyer.exists({ phone }),
      ]);
      if (phoneTaken || phoneOwnedByBuyer) {
        throw new AppError("An account with this phone number already exists.", 409);
      }
    }

    // 🔹 Create a new user
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const user = new User({
      name,
      email,
      password,
      company: {
        name: businessName,
        services: services,
        phone: phone,
      },
      // Top-level field — the one Settings, changePassword's OTP-to-phone
      // flow, and search's WhatsApp fallback (vendor.phone) actually read.
      // company.phone above is a separate, legacy field nothing else
      // consults; without this, phone silently only ever landed there.
      phone: phone || null,
      username,
      country: country,
      sectors,
      description: description || '',
      // Discovery matching (store display + proximity) reads area/state/geo,
      // not company.location/company.state — write the real fields here so
      // the address entered at signup is actually visible/usable later.
      area: address || null,
      state: state || null,
      addressChangedAt: (address || state || geo) ? new Date() : null,
      ...(geo && { geo }),
      emailOtp: {
        code: otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    // Assigns this new user's own referralCode, and — if `referralCode`
    // above matches a real vendor — sets `user.referredBy` too. Must run
    // before save() so both land in the same insert.
    const referralInfo = await prepareReferralForSignup(user, referralCode);

    await user.save();

    // Needs the real user._id from the save above, so this can't be folded
    // into prepareReferralForSignup. A no-op when referralInfo is null
    // (no code given, or an invalid one).
    await recordPendingReferral(user, referralInfo);

    // A Store used to only exist once a vendor visited store settings —
    // real caterer/service vendors with no such visit were invisible to
    // searchStores (no Store doc = never a vector-search candidate) even
    // with products listed. Auto-provision + embed it right away, seeded
    // from what signup already collected, so every vendor is searchable
    // from the moment they verify. Best-effort: must never block signup.
    try {
      const store = await getOrCreateStore(user._id, {
        description: user.description,
        sectors: user.sectors.map(sectorLabel),
        whatsapp: user.phone,
      });
      await embedAndSaveStore(store);
    } catch (err) {
      console.error("[signup] store auto-provision failed:", err.message);
    }

    // 🔹 Send verification email
    await sendVerificationEmail(email, name, otp);

    res.status(201).json({
      success: true,
      message:
        "Account created successfully. Please check your email for the 6-digit verification code.",
    });
  } catch (error) {
    next(error);
  }
};




// Login controller — vendor-only. Buyers never log in at all (2026-08-18,
// "nothing buyers again on the system") — a buyer's only touchpoint with
// identity is the one-time phone+OTP check in buyerAuth.controller.js,
// never a password. This used to also fall back to a Buyer-collection
// branch when unified buyer login existed; that's gone along with it.
// `identifier` is an email or a username; `email` is still accepted as an
// alias — nothing currently sends it, but no reason to hard-break an old
// client that might.
export const login = async (req, res, next) => {
  try {
    const { identifier, email, password } = req.body;
    const idRaw = (identifier ?? email ?? "").trim();
    if (!idRaw || !password) {
      throw new AppError("Email/username and password are required", 400);
    }
    const idLower = idRaw.toLowerCase();

    const user = await User.findOne({
      $or: [{ email: idLower }, { username: idRaw }],
    });
    if (!user) throw new AppError("Invalid credentials", 401);

    await loginAsVendor(user, password, req, res);
  } catch (error) {
    next(error);
  }
};

// Throws AppError for every refusal; login() above forwards it.
async function loginAsVendor(user, password, req, res) {
  if (!(await user.comparePassword(password))) {
    throw new AppError("Invalid credentials", 401);
  }

  // 🔹 Reject blocked accounts (set from the super admin panel). 423 Locked,
  // not 403 — the existing 403 branch here means "unverified email" and the
  // frontend's Next.js BFF layer only forwards {status, message} through
  // generic error plumbing, so status is the only reliable signal it can
  // branch on to show the blocked-account modal instead of the verify flow.
  if (user.isBlocked) {
    throw new AppError(
      user.blockReason || "Your account has been blocked. Please contact support.",
      423,
      { blocked: true },
    );
  }

  // 🔹 Check if user is verified
  if (!user.accountVerified) {
    // Generate new OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    try {
      // Send verification email first
      await sendVerificationEmail(user.email, user.name, otp);

      // Update user OTP details
      user.emailOtp = {
        code: otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // valid for 10 mins
      };

      await user.save();
    } catch (emailError) {
      console.error("Email send error:", emailError);
      throw new AppError(
        "Unable to send verification email at the moment. Please try again later.",
        500,
      );
    }

    // The identifier the vendor typed may have been their USERNAME, not
    // their email — the frontend's /auth/verify redirect needs the real
    // email regardless of which one was entered.
    throw new AppError(
      "Your account is not verified. A new verification code has been sent to your email.",
      403,
      { email: user.email },
    );
  }

  // 🔹 If verified, generate JWT token
  const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  // 🔹 Set token in HttpOnly cookie
  res.cookie("auth_token", token, sessionCookieOptions());

  // ── Pair (or clear) this browser's BUYER cookie (2026-09-16) ────────
  //
  // Symmetric to firebaseAuth.controller.js's own vendor-pairing half —
  // see identityLink.service.js's header for the full reasoning (both
  // sides must have independently proven control of the email before a
  // link is trusted). A vendor logging in whose email also belongs to a
  // real buyer gets that buyer's `buyer_auth_token` set alongside
  // `auth_token`, so /chat shows THEIR OWN history rather than nothing.
  // No match, but a `buyer_auth_token` is already sitting in this
  // browser, means it belongs to someone else entirely — cleared rather
  // than left to leak into this vendor's view of /chat.
  const linkedBuyer = await findBuyerByEmail(user.email);
  if (linkedBuyer) {
    await linkVerifiedAccounts({
      buyerId: linkedBuyer._id,
      vendorId: user._id,
    });
    const buyerToken = jwt.sign(
      { buyerId: linkedBuyer._id, type: "buyer" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.cookie("buyer_auth_token", buyerToken, sessionCookieOptions());
  } else if (req.cookies?.buyer_auth_token) {
    res.clearCookie("buyer_auth_token", clearSessionCookieOptions());
  }

  // 🔹 Success response
  res.status(200).json({
    success: true,
    accountType: "vendor",
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      country: user.country,
      avatar: user.avatar,
      company: {
        name: user.company?.name,
        location: user.company?.location,
        services: user.company?.services || [],
      },
      accountVerified: user.accountVerified,
      username: user.username,
      onboarding: user.onboarding,
    },
    message: "Login successful",
  });
}







export const logout = (req, res) => {
  res.clearCookie("auth_token", clearSessionCookieOptions());

  return res.status(200).json({
    success: true,
    message: "Logout successful",
  });
};









export const verifyEmail = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      throw new AppError("Email and OTP are required", 400);
    }

    // Find the user by email
    const user = await User.findOne({ email });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    if (user.accountVerified) {
      throw new AppError("The user is already verified.", 400);
    }

    // Check if OTP exists and matches
    if (!user.emailOtp || user.emailOtp.code !== Number(otp)) {
      throw new AppError("Invalid OTP", 400);
    }

    // Check if OTP is expired
    const now = new Date();
    if (user.emailOtp.expiresAt < now) {
      throw new AppError("OTP has expired", 400);
    }

    // Mark user as verified
    user.accountVerified = true;

    // Remove OTP after verification (optional)
    user.emailOtp = undefined;

    await user.save();

    // Verified email is ONE of two gates for a referral payout now, not the
    // whole thing — creditPendingReferral (referral.service.js) also
    // requires the referee to have posted REFERRAL_CREDIT_MIN_PRODUCTS real
    // listings before it actually credits anything (added 2026-08-10 after a
    // real leakage: email verification alone let a drained-wallet vendor
    // refer a fresh account and collect the bonus with zero real listings
    // behind it). This call is almost always a no-op in practice — a
    // brand-new account has 0 products at verification time — the real
    // trigger is product.controller.js's createProduct, called again on
    // every product this user ever posts. Kept here too (harmless,
    // idempotent) in case verification is ever reordered to happen after
    // some products already exist. Wrapped separately so a
    // referral-crediting failure never blocks the verification response
    // itself.
    try {
      await creditPendingReferral(user);
    } catch (err) {
      console.error("[referral] credit-on-verify failed:", err.message);
    }

    res.status(201).json({ success: true, message: "Account verified successfully" });
  } catch (err) {
    next(err);
  }
};







export const deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { password } = req.body; // Get password from request body

    if (!userId) {
      throw new AppError("Authentication required", 401);
    }

    if (!password) {
      throw new AppError("Password is required for account deletion", 400);
    }

    const user = await User.findById(userId);

    if (!user) {
      throw new AppError("User not found", 404);
    }

    // Verify password. 403, not 401 — the frontend treats any 401 as an
    // expired session and force-redirects to login, which would log the
    // vendor out for a typo.
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      throw new AppError("Incorrect password", 403);
    }

    // Set accountStatus to false (soft delete)
    user.activeStatus = false;
    await user.save();

    res.clearCookie("auth_token", clearSessionCookieOptions());

    res.status(200).json({
      success: true,
      message: "Account deactivated successfully.",
    });
  } catch (error) {
    next(error);
  }
};








export const verifyPasswordOTP = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      throw new AppError("Email and OTP are required", 400);
    }

    // Find the user by email
    const user = await User.findOne({ email });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    // Check if OTP exists and matches
    if (!user.emailOtp || user.emailOtp.code !== Number(otp)) {
      throw new AppError("Invalid OTP", 400);
    }

    // Check if OTP is expired
    const now = new Date();
    if (user.emailOtp.expiresAt < now) {
      throw new AppError("OTP has expired", 400);
    }

    res.status(201).json({ success: true, message: "OTP verified successfully" });
  } catch (err) {
    next(err);
  }
};






export const resetPassword = async (req, res, next) => {
  try {
    const { email, otp, password } = req.body;

    // 🔹 Validate required fields
    if (!email || !otp || !password) {
      throw new AppError("Email, OTP, and new password are required", 400);
    }

    // 🔹 Validate new password length
    if (password.length < 8) {
      throw new AppError("Password must be at least 8 characters long", 400);
    }

    // 🔹 Find the user by email
    const user = await User.findOne({ email });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    // 🔹 Check if OTP exists and matches
    if (!user.emailOtp || user.emailOtp.code !== Number(otp)) {
      throw new AppError("Invalid OTP", 400);
    }

    // 🔹 Check if OTP is expired
    const now = Date.now();
    if (user.emailOtp.expiresAt < now) {
      throw new AppError("OTP has expired. Please request a new one.", 400);
    }

    // 🔹 Check if new password is same as old password
    const isSamePassword = await user.comparePassword(password);
    if (isSamePassword) {
      throw new AppError("Unable to reset password. Please try again.", 400);
    }

    // 🔹 Update password
    user.password = password;

    // 🔹 Clear OTP after successful password reset
    user.emailOtp = undefined;

    // 🔹 Save user (password will be hashed by pre-save hook)
    await user.save();

    // 🔹 Send success response
    res.status(200).json({
      success: true,
      message:
        "Password reset successful. You can now login with your new password.",
    });
  } catch (error) {
    next(error);
  }
};
