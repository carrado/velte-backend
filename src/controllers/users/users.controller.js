import User from "../../models/Users.js";

export const patchUser = async (req, res) => {
  try {
    const requestingUserId = req.user.userId;
    const { id } = req.params;

    if (requestingUserId.toString() !== id) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const { onboarding } = req.body;

    if (onboarding === undefined) {
      return res.status(400).json({ success: false, message: "No updatable fields provided" });
    }

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // onboarding is a one-way flag: only allow setting it to false
    if (onboarding === false && user.onboarding === true) {
      user.onboarding = false;
      await user.save();
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        onboarding: user.onboarding,
      },
    });
  } catch (error) {
    console.error("Patch user error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
