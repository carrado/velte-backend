import User from "../../models/Users.js";

// Mirrored on the frontend (src/services/settings.ts, ADDRESS_CHANGE_COOLDOWN_MS)
// so the UI can compute the same "locked until" window without another round trip.
const ADDRESS_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

export const updateProfile = async (req, res) => {
  try {
    const { avatar, name, businessName, email, phone, area, state, location } = req.body;
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (avatar !== undefined) user.avatar = avatar;
    if (name !== undefined) user.name = name.trim();
    if (phone !== undefined) user.phone = phone;

    let newGeo;
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
      newGeo = { type: "Point", coordinates: [lng, lat] };
    }

    const currentCoords = user.geo?.coordinates;
    const locationChanging =
      newGeo !== undefined &&
      (!currentCoords ||
        currentCoords[0] !== newGeo.coordinates[0] ||
        currentCoords[1] !== newGeo.coordinates[1]);
    const areaChanging =
      area !== undefined && area.trim() !== (user.area ?? "").trim();
    const stateChanging =
      state !== undefined && state.trim() !== (user.state ?? "").trim();
    const addressChanging = areaChanging || stateChanging || locationChanging;

    let addressChangeBlocked = false;
    let addressChangeAvailableAt = null;

    if (addressChanging && user.addressChangedAt) {
      const availableAt = new Date(
        user.addressChangedAt.getTime() + ADDRESS_CHANGE_COOLDOWN_MS,
      );
      if (availableAt.getTime() > Date.now()) {
        addressChangeBlocked = true;
        addressChangeAvailableAt = availableAt;
      }
    }

    if (addressChanging && !addressChangeBlocked) {
      if (areaChanging) user.area = area;
      if (stateChanging) user.state = state;
      if (locationChanging) user.geo = newGeo;
      user.addressChangedAt = new Date();
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
      addressChangeBlocked,
      addressChangeAvailableAt,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        avatar: user.avatar,
        area: user.area ?? null,
        state: user.state ?? null,
        geo: user.geo ?? null,
        addressChangedAt: user.addressChangedAt ?? null,
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
