import User from "../../models/Users.js";

// Fixed order-total amount (Naira) that triggers escalation. The UI shows this
// locked; the backend enforces it so a crafted request can't change it.
const ESCALATION_AMOUNT = 1000000;

// Defaults returned for any unset field — keep in sync with the User model and
// velte/src/types/ai-settings.ts.
const DEFAULTS = {
  // 24/7 availability enforced for Phase 1; custom operating hours deferred.
  shopHours: {
    is24Hours: true,
  },
  escalation: {
    enabled: false,
    threshold: ESCALATION_AMOUNT,
  },
};

function pickSettings(prefs) {
  const stored = prefs?.aiSettings ?? {};
  return {
    // is24Hours is enforced true — the AI is always available.
    shopHours: { ...DEFAULTS.shopHours, ...(stored.shopHours ?? {}), is24Hours: true },
    // threshold is always the fixed amount, whatever is stored.
    escalation: {
      ...DEFAULTS.escalation,
      ...(stored.escalation ?? {}),
      threshold: ESCALATION_AMOUNT,
    },
  };
}

function validateShopHours(sh) {
  if (sh == null) return null;
  if (typeof sh !== "object") return "shopHours must be an object";
  if (sh.is24Hours !== undefined && typeof sh.is24Hours !== "boolean") {
    return "shopHours.is24Hours must be true or false";
  }
  return null;
}

function validateEscalation(esc) {
  if (esc == null) return null;
  if (typeof esc !== "object") return "escalation must be an object";
  if (esc.enabled !== undefined && typeof esc.enabled !== "boolean") {
    return "escalation.enabled must be true or false";
  }
  // threshold is intentionally ignored (fixed server-side); no validation needed.
  return null;
}

export const getAiSettings = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("preferences").lean();
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json({ success: true, data: pickSettings(user.preferences) });
  } catch (error) {
    console.error("Get AI settings error:", error);
    res.status(500).json({ message: "Failed to retrieve AI settings" });
  }
};

export const updateAiSettings = async (req, res) => {
  try {
    const { shopHours, escalation } = req.body ?? {};

    if (shopHours === undefined && escalation === undefined) {
      return res.status(400).json({ message: "Provide shopHours or escalation to update" });
    }

    const shErr = validateShopHours(shopHours);
    if (shErr) return res.status(400).json({ message: shErr });
    const escErr = validateEscalation(escalation);
    if (escErr) return res.status(400).json({ message: escErr });

    const user = await User.findById(req.user.userId).select("preferences");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.preferences) user.preferences = {};
    const current = user.preferences.aiSettings ?? {};

    user.preferences.aiSettings = {
      shopHours:
        shopHours !== undefined
          ? { ...DEFAULTS.shopHours, ...current.shopHours, ...shopHours, is24Hours: true }
          : current.shopHours,
      escalation:
        escalation !== undefined
          ? {
              ...DEFAULTS.escalation,
              ...current.escalation,
              ...escalation,
              threshold: ESCALATION_AMOUNT, // force fixed amount
            }
          : current.escalation,
    };

    user.markModified("preferences.aiSettings");
    await user.save();

    res.status(200).json({
      success: true,
      message: "AI settings saved",
      data: pickSettings(user.preferences),
    });
  } catch (error) {
    console.error("Save AI settings error:", error);
    res.status(500).json({ message: "Failed to save AI settings" });
  }
};
