import User from "../../models/Users.js";
import { generateTemplates } from "../../services/documents.service.js";

// Defaults returned for any unset field — keep in sync with the User model and
// velte/src/types/invoice.ts. The logo is NOT here; documents use `user.avatar`.
const DEFAULTS = {
  invoice: {
    business: { name: "", address: "", phone: "", email: "", taxId: "", website: "" },
    footerNote:
      "Thank you for your business! Payment is due within the specified period.",
    primaryColor: "#f97316",
    bankName: "",
    accountNumber: "",
    accountName: "",
    dueDays: 7,
    templatePdfUrl: null,
  },
  receipt: {
    business: { name: "", address: "", phone: "", email: "", taxId: "", website: "" },
    thankYouMessage: "Thank you for your purchase!",
    returnPolicy: "Items can be returned within 7 days with original receipt.",
    primaryColor: "#f97316",
    showBarcode: true,
    templatePdfUrl: null,
  },
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Merge a stored section over the defaults (business merged one level deeper).
function mergeSection(defaults, stored = {}) {
  return {
    ...defaults,
    ...stored,
    business: { ...defaults.business, ...(stored.business ?? {}) },
  };
}

function pickSettings(prefs) {
  const stored = prefs?.documentSettings ?? {};
  return {
    invoice: mergeSection(DEFAULTS.invoice, stored.invoice),
    receipt: mergeSection(DEFAULTS.receipt, stored.receipt),
  };
}

// Validate a partial section; returns an error string or null. Only checks fields
// that were actually provided (the UI sends whole sections, but stay defensive).
function validateSection(section) {
  if (section == null) return null;
  if (typeof section !== "object") return "Invalid settings payload";

  if (section.primaryColor !== undefined && !HEX_RE.test(section.primaryColor)) {
    return "primaryColor must be a hex colour like #f97316";
  }
  if (section.dueDays !== undefined) {
    if (
      typeof section.dueDays !== "number" ||
      !Number.isInteger(section.dueDays) ||
      section.dueDays < 0 ||
      section.dueDays > 365
    ) {
      return "dueDays must be an integer between 0 and 365";
    }
  }
  if (section.showBarcode !== undefined && typeof section.showBarcode !== "boolean") {
    return "showBarcode must be true or false";
  }
  const b = section.business;
  if (b !== undefined) {
    if (typeof b !== "object") return "business must be an object";
    if (b.email && !EMAIL_RE.test(b.email)) return "business email is invalid";
  }
  return null;
}

export const getInvoiceSettings = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("preferences").lean();
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      success: true,
      data: pickSettings(user.preferences),
    });
  } catch (error) {
    console.error("Get invoice settings error:", error);
    res.status(500).json({ message: "Failed to retrieve invoice settings" });
  }
};

export const updateInvoiceSettings = async (req, res) => {
  try {
    const { invoice, receipt } = req.body ?? {};

    if (invoice === undefined && receipt === undefined) {
      return res.status(400).json({ message: "Provide an invoice or receipt section to update" });
    }

    const invoiceError = validateSection(invoice);
    if (invoiceError) return res.status(400).json({ message: invoiceError });
    const receiptError = validateSection(receipt);
    if (receiptError) return res.status(400).json({ message: receiptError });

    const user = await User.findById(req.user.userId).select("preferences");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.preferences) user.preferences = {};
    const current = user.preferences.documentSettings ?? {};

    // Always write both sections as full, defaults-merged objects. Assigning
    // `undefined` to a section (e.g. saving only `receipt` before any invoice
    // exists) makes Mongoose throw "Cast to Object failed". The untouched section
    // is just normalised from its current value + defaults — no data loss.
    const mergedInvoice = mergeSection(DEFAULTS.invoice, current.invoice);
    const mergedReceipt = mergeSection(DEFAULTS.receipt, current.receipt);

    user.preferences.documentSettings = {
      invoice:
        invoice !== undefined
          ? mergeSection(mergedInvoice, invoice)
          : mergedInvoice,
      receipt:
        receipt !== undefined
          ? mergeSection(mergedReceipt, receipt)
          : mergedReceipt,
    };

    user.markModified("preferences.documentSettings");
    await user.save();

    // Regenerate ONLY the saved section's template PDF (sample data) in the
    // background and store its CDN URL. Fire-and-forget so the save stays snappy
    // and a PDF/CDN outage never fails the request — the URL surfaces on the next
    // GET. Saving the receipt must not touch the invoice PDF and vice versa.
    generateTemplates(user._id, {
      invoice: invoice !== undefined,
      receipt: receipt !== undefined,
    }).catch((e) =>
      console.error("[invoiceSettings] template PDF generation failed:", e.message),
    );

    res.status(200).json({
      success: true,
      message: "Invoice settings saved",
      data: pickSettings(user.preferences),
    });
  } catch (error) {
    console.error("Save invoice settings error:", error);
    res.status(500).json({ message: "Failed to save invoice settings" });
  }
};
