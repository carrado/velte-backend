import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";

export const patchUser = async (req, res, next) => {
  try {
    const requestingUserId = req.user.userId;
    const { id } = req.params;

    if (requestingUserId.toString() !== id) {
      throw new AppError("Forbidden", 403);
    }

    const { onboarding } = req.body;

    if (onboarding === undefined) {
      throw new AppError("No updatable fields provided", 400);
    }

    const user = await User.findById(id);

    if (!user) {
      throw new AppError("User not found", 404);
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
    next(error);
  }
};
