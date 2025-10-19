import User from "../../models/Users.js";

export const verifyEmail = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    // Find the user by email
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if OTP exists and matches
    if (!user.emailOtp || user.emailOtp.code !== Number(otp)) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // Check if OTP is expired
    const now = new Date();
    if (user.emailOtp.expiresAt < now) {
      return res.status(400).json({ message: "OTP has expired" });
    }

    // Mark user as verified
    user.profile.verified = true;

    // Remove OTP after verification (optional)
    user.emailOtp = undefined;

    await user.save();

    res.status(201).json({ message: "Account verified successfully" });
  } catch (err) {
    console.error("Email verification error:", err);
    res.status(500).json({ message: "Something went wrong" });
  }
};
