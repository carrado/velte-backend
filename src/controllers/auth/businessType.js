import User from "../../models/Users.js";

export const updateBusinessType = async (req, res) => {
  try {
    const { businessType } = req.body;

    if (!businessType || !['retail', 'food', 'service', 'both', 'food_both'].includes(businessType)) {
      return res.status(400).json({ message: "businessType must be one of 'retail', 'food', 'service', 'both', 'food_both'" });
    }

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { businessType },
      { new: true, runValidators: true }
    ).select("-password -emailOtp -changePasswordOtp");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ success: true, user });
  } catch (error) {
    console.error("Update business type error:", error);
    res.status(500).json({ message: "Failed to update business type" });
  }
};

export const updateFoodSettings = async (req, res) => {
  try {
    const { estimatedPrepMins, autoAccept } = req.body;

    if (estimatedPrepMins !== undefined && (typeof estimatedPrepMins !== 'number' || estimatedPrepMins < 0)) {
      return res.status(400).json({ message: "estimatedPrepMins must be a non-negative number" });
    }

    if (autoAccept !== undefined && typeof autoAccept !== 'boolean') {
      return res.status(400).json({ message: "autoAccept must be a boolean" });
    }

    const update = {};
    if (estimatedPrepMins !== undefined) update['preferences.foodSettings.estimatedPrepMins'] = estimatedPrepMins;
    if (autoAccept !== undefined) update['preferences.foodSettings.autoAccept'] = autoAccept;

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $set: update },
      { new: true, runValidators: true }
    ).select("-password -emailOtp -changePasswordOtp");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      success: true,
      foodSettings: user.preferences.foodSettings,
    });
  } catch (error) {
    console.error("Update food settings error:", error);
    res.status(500).json({ message: "Failed to update food settings" });
  }
};
