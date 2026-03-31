import User from "../../models/Users.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../../helpers/emailSender.js";

export const resendOTP = async (req, res) => {
  try {
    const { email } = req.body;

    // 🔹 Find user
    const user = await User.findOne({ email });


    if (user.accountVerified) {
      return res.status(400).json({ message: "The user is already verified." });
    }


    if (!user) {
      return res.status(401).json({ message: "Invalid email address" });
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
    console.error("Resend OTP error:", error);
    res.status(500).json({ message: "Failed to resend OTP" });
  }
};


export const passwordResetOTP = async (req, res) => {
  try {
    const { email } = req.body;

    // 🔹 Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid email address" });
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
    console.error("Resend OTP error:", error);
    res.status(500).json({ message: "Failed to resend OTP" });
  }
};

