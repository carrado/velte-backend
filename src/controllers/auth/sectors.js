import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import { getOrCreateStore } from "../store/store.controller.js";
import { embedAndSaveStore } from "../../services/embedding.service.js";
import { sectorLabel, isKnownSector } from "../../utils/sectorLabels.js";

const MAX_SECTORS = 5;

// The single write path for a vendor's operating sectors, post-signup —
// called both by a future "add sectors" settings surface and by the Store
// editor's Sectors card (which used to write Store.sectors directly; now it
// calls this instead, so User.sectors stays the one canonical list and
// Store.sectors is just its derived display-label cache).
export const updateSectors = async (req, res, next) => {
  try {
    const { sectors } = req.body;

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

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { sectors },
      { new: true, runValidators: true }
    ).select("-password -emailOtp -changePasswordOtp");

    if (!user) {
      throw new AppError("User not found", 404);
    }

    try {
      const store = await getOrCreateStore(user._id, {
        sectors: sectors.map(sectorLabel),
      });
      store.sectors = sectors.map(sectorLabel);
      await store.save();
      await embedAndSaveStore(store);
    } catch (err) {
      console.error("[sectors] store sync failed:", err.message);
    }

    res.status(200).json({ success: true, user });
  } catch (error) {
    next(error);
  }
};

export const updateFoodSettings = async (req, res, next) => {
  try {
    const { estimatedPrepMins, autoAccept } = req.body;

    if (estimatedPrepMins !== undefined && (typeof estimatedPrepMins !== 'number' || estimatedPrepMins < 0)) {
      throw new AppError("estimatedPrepMins must be a non-negative number", 400);
    }

    if (autoAccept !== undefined && typeof autoAccept !== 'boolean') {
      throw new AppError("autoAccept must be a boolean", 400);
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
      throw new AppError("User not found", 404);
    }

    res.status(200).json({
      success: true,
      foodSettings: user.preferences.foodSettings,
    });
  } catch (error) {
    next(error);
  }
};
