import User from "../../models/Users.js";
import { sendPasswordChangeEmail } from "../../helpers/emailSender.js";
import { sendSms } from "../../helpers/smsSender.js";

// Step 1 — validate credentials, send OTP to email + SMS
export const requestPasswordChange = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All three password fields are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "New password and confirm password do not match" });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isCurrentCorrect = await user.comparePassword(currentPassword);
    if (!isCurrentCorrect) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    const isSameAsNew = await user.comparePassword(newPassword);
    if (isSameAsNew) {
      return res.status(400).json({ message: "New password must be different from your current password" });
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
    console.error("Request password change error:", error);
    res.status(500).json({ message: "Failed to initiate password change" });
  }
};

// Step 2 — verify OTP and apply the new password
export const confirmPasswordChange = async (req, res) => {
  try {
    const { otp, newPassword, confirmPassword } = req.body;

    if (!otp || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "OTP, new password, and confirm password are required" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.changePasswordOtp?.code) {
      return res.status(400).json({ message: "No pending password change request. Please start over." });
    }

    if (user.changePasswordOtp.code !== Number(otp)) {
      return res.status(400).json({ message: "Invalid verification code" });
    }

    if (new Date() > user.changePasswordOtp.expiresAt) {
      user.changePasswordOtp = undefined;
      await user.save();
      return res.status(400).json({ message: "Verification code has expired. Please start over." });
    }

    user.password = newPassword;
    user.changePasswordOtp = undefined;
    await user.save();

    res.status(200).json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    console.error("Confirm password change error:", error);
    res.status(500).json({ message: "Failed to update password" });
  }
};
