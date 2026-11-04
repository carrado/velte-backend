import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../../helpers/emailSender.js";

export const resendOTP = async (req, res, next) => {
  try {
    const { email } = req.body;

    // 🔹 Find user
    const user = await User.findOne({ email });

    // 404, not 401 — same reasoning as passwordResetOTP below.
    if (!user) {
      throw new AppError("Invalid email address", 404);
    }

    if (user.accountVerified) {
      throw new AppError("The user is already verified.", 400);
    }

    // 🔹 Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 🔹 Send verification email first
    await sendVerificationEmail(user.email, user.name, otp);

    // 🔹 Update user only after email is sent successfully
    user.emailOtp = {
      code: otp,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // valid for 10 mins
    };

    await user.save();

    res.status(200).json({
      success: true,
      message: "OTP re-sent successfully",
    });
  } catch (error) {
    next(error);
  }
};


export const passwordResetOTP = async (req, res, next) => {
  try {
    const { email } = req.body;

    // 🔹 Find user
    const user = await User.findOne({ email });
    if (!user) {
      // 404, not 401 — this is a public, pre-auth endpoint; "no account
      // with this email" is a lookup miss, not an authentication failure.
      // The distinction matters because the frontend's api-client treats
      // ANY 401 as "session expired" and force-redirects to /auth/login —
      // harmless today only because this happens to be called from a page
      // already under /auth/*, not because the status code was correct.
      throw new AppError("Invalid email address", 404);
    }

    // 🔹 Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 🔹 Send verification email first
    await sendPasswordResetEmail(user.email, user.name, otp);

    // 🔹 Update user only after email is sent successfully
    user.emailOtp = {
      code: otp,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // valid for 10 mins
    };

    await user.save();

    res.status(200).json({
      success: true,
      message: "OTP re-sent successfully",
    });
  } catch (error) {
    next(error);
  }
};
