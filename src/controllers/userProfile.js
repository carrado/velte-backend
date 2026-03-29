import User from "../models/Users.js";

export const profile = async (req, res) => {
  try {  
    const user = await User.findById(req.user._id)
      .select("-password -emailOtp"); // exclude sensitive fields

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.profile?.verified) {
      return res.status(403).json({
        success: false,
        message: "Your account is not verified. Please verify your email.",
        email: user.email
      });
    }

    res.status(200).json({
      success: true,
      user,
    });
  } catch (err) {
    console.error("Profile fetch error:", err);
    res.status(500).json({ message: "Failed to fetch user profile" });
  }
};
