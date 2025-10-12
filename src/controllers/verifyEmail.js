import jwt from "jsonwebtoken";
import User from "../models/Users.js";

export const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: "Verification token is required" });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update verified status inside profile
    user.profile.verified = true;
    await user.save();

    // Redirect to client app after successful verification
    res.redirect(`${process.env.CLIENT_URL}/app`);
  } catch (err) {
    console.error("Email verification error:", err);
    res.status(400).json({ message: "Invalid or expired verification link" });
  }
};
