import User from "../models/Users.js";
import { buildInvoiceHtml, buildReceiptHtml } from "./documentHtml.js";
import { renderPdfFromHtml } from "./pdf.service.js";
import { uploadPdf, isCloudinaryConfigured } from "./cloudinary.service.js";

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-NG", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

// Abbreviate a business name to uppercase initials for the receipt number prefix:
// "Acme Stores Limited" → "ASL", "Mainland" → "MAI". Falls back to "RCP".
function abbreviate(name) {
  if (!name || !name.trim()) return "RCP";
  const words = name.trim().split(/\s+/).filter(Boolean);
  const abbr =
    words.length === 1 ? words[0].slice(0, 3) : words.map((w) => w[0]).join("");
  return abbr.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5) || "RCP";
}

// Pick the business name shown on the receipt (config first, then account).
const receiptBusinessName = (user, ds) =>
  ds?.receipt?.business?.name || user?.company?.name || user?.name || "";

// Random four-digit segment (1000–9999) for the receipt number.
const fourDigit = () => String(Math.floor(1000 + Math.random() * 9000));

// Sample line items for template PDFs — mirrors the frontend preview.
const SAMPLE_ITEMS = [
  { name: "Product A", qty: 2, price: 15000 },
  { name: "Product B", qty: 1, price: 8500 },
];
const SAMPLE_CUSTOMER = {
  name: "Customer Name",
  email: "customer@email.com",
  phone: "+234 800 000 0000",
};
const sampleTax = () =>
  Math.round(SAMPLE_ITEMS.reduce((s, i) => s + i.qty * i.price, 0) * 0.075);

/**
 * Render the merchant's invoice + receipt TEMPLATE PDFs (branding with sample
 * data) and store their Cloudinary URLs on the user. Called fire-and-forget when
 * settings are saved. No-op (logged) if Cloudinary isn't configured.
 */
export async function generateTemplates(
  userId,
  { invoice = true, receipt = true } = {},
) {
  if (!isCloudinaryConfigured()) {
    console.warn("[documents] Cloudinary not configured — skipping template PDFs");
    return null;
  }
  if (!invoice && !receipt) return null;

  const user = await User.findById(userId)
    .select("avatar preferences.documentSettings company name")
    .lean();
  if (!user) return null;

  const ds = user.preferences?.documentSettings || {};
  const logoUrl = user.avatar || null;
  const today = new Date();
  const $set = {};
  const result = {};

  // Only (re)generate the section(s) that were actually saved, so saving the
  // receipt doesn't touch the invoice PDF and vice versa.
  if (invoice) {
    const due = new Date(today);
    due.setDate(due.getDate() + (ds.invoice?.dueDays ?? 7));
    const html = buildInvoiceHtml({
      config: ds.invoice || {},
      logoUrl,
      data: {
        docNumber: "INV-0001",
        issueDate: fmtDate(today),
        dueDate: fmtDate(due),
        customer: SAMPLE_CUSTOMER,
        items: SAMPLE_ITEMS,
        tax: sampleTax(),
      },
    });
    const pdf = await renderPdfFromHtml(html);
    const url = await uploadPdf(pdf, { folder: "velte/templates", publicId: `invoice-template-${userId}` });
    $set["preferences.documentSettings.invoice.templatePdfUrl"] = url;
    result.invoiceUrl = url;
  }

  if (receipt) {
    const html = buildReceiptHtml({
      config: ds.receipt || {},
      logoUrl,
      data: {
        // Sample number for the template — real receipts use a random segment +
        // an incrementing per-store sequence.
        docNumber: `${abbreviate(receiptBusinessName(user, ds))}-${fourDigit()}-0001`,
        issueDate: fmtDate(today),
        customer: SAMPLE_CUSTOMER,
        items: SAMPLE_ITEMS,
        tax: sampleTax(),
      },
    });
    const pdf = await renderPdfFromHtml(html);
    const url = await uploadPdf(pdf, { folder: "velte/templates", publicId: `receipt-template-${userId}` });
    $set["preferences.documentSettings.receipt.templatePdfUrl"] = url;
    result.receiptUrl = url;
  }

  await User.updateOne({ _id: userId }, { $set });
  return result;
}

/**
 * Render the REAL receipt PDF for a paid order — the merchant's receipt template
 * filled with the actual products, amount, and buyer details — upload it, and
 * return `{ url, receiptNumber }`. Caller persists both on the order and
 * dispatches them to Staffly.
 *
 * The receipt number is `{BUSINESS-ABBR}-{seq}` (e.g. ASL-0001), where `seq`
 * increments per store. The barcode renders the same number. To stay idempotent
 * on webhook retries, an order that already has a `receiptNumber` reuses it
 * instead of claiming a new one.
 */
export async function generateOrderReceipt(order) {
  if (!isCloudinaryConfigured()) {
    console.warn("[documents] Cloudinary not configured — skipping order receipt PDF");
    return null;
  }

  let receiptNumber = order.receiptNumber || null;
  let user;
  if (receiptNumber) {
    user = await User.findById(order.merchantId)
      .select("avatar preferences.documentSettings company name")
      .lean();
  } else {
    // Atomically claim the next sequence number for this store.
    user = await User.findByIdAndUpdate(
      order.merchantId,
      { $inc: { receiptSequence: 1 } },
      { new: true },
    )
      .select("avatar preferences.documentSettings company name receiptSequence")
      .lean();
    const ds0 = user?.preferences?.documentSettings || {};
    const seq = user?.receiptSequence ?? 1;
    receiptNumber = `${abbreviate(receiptBusinessName(user, ds0))}-${fourDigit()}-${String(seq).padStart(4, "0")}`;
  }

  const ds = user?.preferences?.documentSettings || {};

  // Effective unit price = lineTotal / qty so the rendered line totals always sum
  // to what was actually charged (order.amount), modifiers included.
  const items = (order.items || []).map((i) => {
    const qty = i.quantity ?? 1;
    const line = i.lineTotal ?? (i.basePrice ?? 0) * qty;
    return { name: i.name, qty, price: qty ? line / qty : line };
  });

  const html = buildReceiptHtml({
    config: ds.receipt || {},
    logoUrl: user?.avatar || null,
    data: {
      docNumber: receiptNumber,
      issueDate: fmtDate(order.updatedAt || order.createdAt || new Date()),
      customer: {
        name: order.customerName,
        email: order.customerEmail,
        phone: order.customerPhone,
        address: order.deliveryAddress || order.customerAddress,
      },
      items,
      tax: 0, // order.amount already reflects the charged total
    },
  });

  const pdf = await renderPdfFromHtml(html);
  const url = await uploadPdf(pdf, { folder: "velte/receipts", publicId: `receipt-${order._id}` });
  return { url, receiptNumber };
}
