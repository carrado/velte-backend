import User from "../../models/Users.js";
import AISetup from "../../models/AiSetup.model.js";
import { uploadWhatsAppProfilePhoto } from "../../services/meta.service.js";

export const updateProfile = async (req, res) => {
  try {
    const { avatar, name, businessName, email, phone } = req.body;
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (avatar !== undefined) user.avatar = avatar;
    if (name !== undefined) user.name = name.trim();
    if (phone !== undefined) user.phone = phone;

    if (businessName !== undefined) {
      if (!user.company) user.company = {};
      user.company.name = businessName;
    }

    if (email !== undefined) {
      const normalized = email.toLowerCase().trim();
      if (normalized !== user.email) {
        const taken = await User.findOne({ email: normalized, _id: { $ne: user._id } });
        if (taken) {
          return res.status(409).json({ message: "Email is already in use" });
        }
        user.email = normalized;
      }
    }

    await user.save();

    // If the avatar changed, push it to WhatsApp Business Profile non-blocking.
    if (avatar !== undefined && user.avatar) {
      AISetup.findOne({ userId: user._id })
        .select("+metaAccessToken")
        .then((setup) => {
          if (setup?.metaConnected && setup.selectedNumberId && setup.metaAccessToken) {
            return uploadWhatsAppProfilePhoto(user.avatar, setup.selectedNumberId, setup.metaAccessToken);
          }
        })
        .catch((err) => console.warn("WhatsApp profile photo sync failed:", err.message));
    }

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        avatar: user.avatar,
        company: {
          name: user.company?.name ?? null,
          location: user.company?.location ?? null,
          services: user.company?.services ?? [],
        },
        username: user.username,
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ message: "Failed to update profile" });
  }
};
