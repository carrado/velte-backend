import User from "../../models/Users.js";

function pickNotifications(prefs) {
  const n = prefs?.notifications ?? {};
  return {
    orders:           n.orders           ?? true,
    invoices:         n.invoices         ?? false,
    invoiceThreshold: n.invoiceThreshold ?? 0,
    productUpdates:   n.productUpdates   ?? false,
    push:             n.push             ?? true,
  };
}

export const getNotificationSettings = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("preferences");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      success: true,
      notifications: pickNotifications(user.preferences),
    });
  } catch (error) {
    console.error("Get notification settings error:", error);
    res.status(500).json({ message: "Failed to retrieve notification settings" });
  }
};

export const saveNotificationSettings = async (req, res) => {
  try {
    const { orders, invoices, invoiceThreshold, productUpdates, push } = req.body;

    // Validate types for anything that was provided
    const booleanFields = { orders, invoices, productUpdates, push };
    for (const [key, val] of Object.entries(booleanFields)) {
      if (val !== undefined && typeof val !== "boolean") {
        return res.status(400).json({ message: `${key} must be true or false` });
      }
    }

    if (invoiceThreshold !== undefined) {
      if (typeof invoiceThreshold !== "number" || invoiceThreshold < 0) {
        return res.status(400).json({ message: "invoiceThreshold must be a non-negative number" });
      }
    }

    const user = await User.findById(req.user.userId).select("preferences");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.preferences) user.preferences = {};
    if (!user.preferences.notifications) user.preferences.notifications = {};

    if (orders           !== undefined) user.preferences.notifications.orders           = orders;
    if (invoices         !== undefined) user.preferences.notifications.invoices         = invoices;
    if (invoiceThreshold !== undefined) user.preferences.notifications.invoiceThreshold = invoiceThreshold;
    if (productUpdates   !== undefined) user.preferences.notifications.productUpdates   = productUpdates;
    if (push             !== undefined) user.preferences.notifications.push             = push;

    user.markModified("preferences");
    await user.save();

    res.status(200).json({
      success: true,
      message: "Notification settings saved",
      notifications: pickNotifications(user.preferences),
    });
  } catch (error) {
    console.error("Save notification settings error:", error);
    res.status(500).json({ message: "Failed to save notification settings" });
  }
};
