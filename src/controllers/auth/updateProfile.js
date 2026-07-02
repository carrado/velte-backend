import User from "../../models/Users.js";

export const updateProfile = async (req, res) => {
  try {
    const { avatar, name, businessName, email, phone, area, location } = req.body;
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (avatar !== undefined) user.avatar = avatar;
    if (name !== undefined) user.name = name.trim();
    if (phone !== undefined) user.phone = phone;
    if (area !== undefined) user.area = area;

    if (location !== undefined) {
      const { lat, lng } = location ?? {};
      if (
        typeof lat !== "number" ||
        typeof lng !== "number" ||
        lat < -90 || lat > 90 ||
        lng < -180 || lng > 180
      ) {
        return res.status(400).json({ message: "location must be { lat, lng } within valid range" });
      }
      user.geo = { type: "Point", coordinates: [lng, lat] };
    }

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

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        avatar: user.avatar,
        area: user.area ?? null,
        geo: user.geo ?? null,
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
