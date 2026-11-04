import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendPasswordChangeEmail } from "../../helpers/emailSender.js";
import { sendSms } from "../../services/sendchamp.service.js";

// Step 1 — validate credentials, send OTP to email + SMS
export const requestPasswordChange = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      throw new AppError("All three password fields are required", 400);
    }

    if (newPassword.length < 8) {
      throw new AppError("New password must be at least 8 characters", 400);
    }

    if (newPassword !== confirmPassword) {
      throw new AppError("New password and confirm password do not match", 400);
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      throw new AppError("User not found", 404);
    }

    // 403, not 401 — the frontend treats any 401 as an expired session and
    // force-redirects to login, which would log the vendor out for a typo.
    const isCurrentCorrect = await user.comparePassword(currentPassword);
    if (!isCurrentCorrect) {
      throw new AppError("Current password is incorrect", 403);
    }

    const isSameAsNew = await user.comparePassword(newPassword);
    if (isSameAsNew) {
      throw new AppError("New password must be different from your current password", 400);
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await sendPasswordChangeEmail(user.email, user.name, otp);

    if (user.phone) {
      try {
        await sendSms(
          user.phone,
          `Your Velte password change code is: ${otp}. Valid for 10 minutes. Do not share this code.`
        );
      } catch (smsErr) {
        // SMS failure should not block the flow — email was already sent
        console.error("SMS delivery failed:", smsErr.message);
      }
    }

    user.changePasswordOtp = { code: Number(otp), expiresAt };
    await user.save();

    res.status(200).json({
      success: true,
      message: `A verification code has been sent to your email${user.phone ? " and phone number" : ""}`,
    });
  } catch (error) {
    next(error);
  }
};

// Step 2 — verify OTP and apply the new password
export const confirmPasswordChange = async (req, res, next) => {
  try {
    const { otp, newPassword, confirmPassword } = req.body;

    if (!otp || !newPassword || !confirmPassword) {
      throw new AppError("OTP, new password, and confirm password are required", 400);
    }

    if (newPassword !== confirmPassword) {
      throw new AppError("Passwords do not match", 400);
    }

    if (newPassword.length < 8) {
      throw new AppError("New password must be at least 8 characters", 400);
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      throw new AppError("User not found", 404);
    }

    if (!user.changePasswordOtp?.code) {
      throw new AppError("No pending password change request. Please start over.", 400);
    }

    if (user.changePasswordOtp.code !== Number(otp)) {
      throw new AppError("Invalid verification code", 400);
    }

    if (new Date() > user.changePasswordOtp.expiresAt) {
      user.changePasswordOtp = undefined;
      await user.save();
      throw new AppError("Verification code has expired. Please start over.", 400);
    }

    user.password = newPassword;
    user.changePasswordOtp = undefined;
    await user.save();

    res.status(200).json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    next(error);
  }
};
