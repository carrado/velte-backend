// Builds the HTML for invoice/receipt PDFs, mirroring the frontend previews in
// velte/src/components/settings/SettingsPage.tsx (InvoicePreview / ReceiptPreview).
// Puppeteer renders this HTML to PDF, so the document matches what the merchant
// sees in Settings. The business logo is the account avatar (passed as logoUrl).

const FALLBACK_COLOR = "#f97316";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n) {
  return "₦" + Number(n || 0).toLocaleString("en-NG");
}

function hexTint(hex) {
  // ~9% opacity tint string usable in rgba; falls back gracefully.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "rgba(249,115,22,0.10)";
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},0.10)`;
}

function baseStyles(color) {
  return `
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; margin: 0; font-size: 13px; }
    .wrap { max-width: 720px; margin: 0 auto; }
    .muted { color: #9ca3af; }
    .row { display: flex; justify-content: space-between; }
    table { width: 100%; border-collapse: collapse; }
    .accent { color: ${color}; }
    .accent-bg { background: ${hexTint(color)}; }
  `;
}

// Decorative barcode (mirrors the receipt preview): a row of varying-width bars
// with the code underneath.
function barcodeHtml(code) {
  const bars = Array.from(
    { length: 48 },
    (_, i) =>
      `<span style="display:inline-block;width:${i % 3 === 0 ? 3 : 1.5}px;height:34px;background:#1f2937;"></span>`,
  ).join("");
  return `<div style="text-align:center;margin-top:18px;">
    <div style="display:flex;justify-content:center;gap:1px;">${bars}</div>
    <div class="muted" style="font-size:11px;letter-spacing:.2em;margin-top:6px;">${esc(code)}</div>
  </div>`;
}

/** items: [{ name, qty, price }]; returns { subtotal, total } */
function computeTotals(items, tax = 0) {
  const subtotal = items.reduce(
    (s, i) => s + Number(i.qty || 0) * Number(i.price || 0),
    0,
  );
  return { subtotal, total: subtotal + Number(tax || 0) };
}

export function buildInvoiceHtml({ config = {}, logoUrl, data }) {
  const color = config.primaryColor || FALLBACK_COLOR;
  const b = config.business || {};
  const items = data.items || [];
  const tax = Number(data.tax || 0);
  const { subtotal, total } = computeTotals(items, tax);

  const rows = items
    .map(
      (i) => `
      <tr>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-weight:500;">${esc(i.name)}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;text-align:center;color:#6b7280;">${esc(i.qty)}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;text-align:right;color:#6b7280;">${money(i.price)}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:600;">${money(i.qty * i.price)}</td>
      </tr>`,
    )
    .join("");

  const bank =
    b.bankName || config.bankName || config.accountNumber
      ? `<div class="accent-bg" style="border-radius:10px;padding:12px;margin-bottom:14px;">
           <div class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Payment Details</div>
           <div><strong>Bank:</strong> ${esc(config.bankName || "")}</div>
           <div><strong>Account:</strong> ${esc(config.accountNumber || "")}</div>
           <div><strong>Name:</strong> ${esc(config.accountName || "")}</div>
         </div>`
      : "";

  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyles(color)}</style></head>
  <body><div class="wrap">
    <div class="row" style="align-items:flex-start;margin-bottom:24px;">
      <div>
        <div class="accent" style="font-size:30px;font-weight:800;letter-spacing:-.02em;">INVOICE</div>
        <div class="muted" style="margin-top:2px;">#${esc(data.docNumber)}</div>
      </div>
      <div style="text-align:right;">
        ${logoUrl ? `<img src="${esc(logoUrl)}" style="width:54px;height:54px;border-radius:8px;object-fit:cover;margin-bottom:6px;" />` : ""}
        <div style="font-weight:700;">${esc(b.name || "Your Business Name")}</div>
        <div class="muted" style="line-height:1.5;">${esc(b.address || "")}<br/>${esc(b.phone || "")}<br/>${esc(b.email || "")}${b.taxId ? `<br/>${esc(b.taxId)}` : ""}</div>
      </div>
    </div>

    <div class="row" style="gap:16px;margin-bottom:22px;">
      <div style="flex:1;background:#f9fafb;border-radius:10px;padding:12px;">
        <div class="muted" style="font-size:10px;font-weight:600;text-transform:uppercase;">Issue Date</div>
        <div style="font-weight:600;margin-top:2px;">${esc(data.issueDate)}</div>
      </div>
      <div class="accent-bg" style="flex:1;border-radius:10px;padding:12px;">
        <div class="accent" style="font-size:10px;font-weight:600;text-transform:uppercase;">Due Date</div>
        <div style="font-weight:600;margin-top:2px;">${esc(data.dueDate)}</div>
      </div>
    </div>

    <div style="margin-bottom:18px;">
      <div class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Billed To</div>
      <div style="font-weight:600;">${esc(data.customer?.name || "Customer")}</div>
      <div class="muted">${[data.customer?.email, data.customer?.phone].filter(Boolean).map(esc).join(" · ")}</div>
      ${data.customer?.address ? `<div class="muted">${esc(data.customer.address)}</div>` : ""}
    </div>

    <table style="margin-bottom:18px;">
      <thead>
        <tr class="accent accent-bg" style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;">
          <th style="padding:8px 12px;text-align:left;border-radius:6px 0 0 6px;">Item</th>
          <th style="padding:8px 12px;text-align:center;">Qty</th>
          <th style="padding:8px 12px;text-align:right;">Price</th>
          <th style="padding:8px 12px;text-align:right;border-radius:0 6px 6px 0;">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="row" style="margin-bottom:18px;">
      <div></div>
      <div style="width:220px;">
        <div class="row muted" style="padding:2px 0;"><span>Subtotal</span><span>${money(subtotal)}</span></div>
        ${tax ? `<div class="row muted" style="padding:2px 0;"><span>Tax</span><span>${money(tax)}</span></div>` : ""}
        <div class="row accent" style="font-weight:800;padding-top:8px;border-top:1px solid #e5e7eb;margin-top:6px;"><span>Total</span><span>${money(total)}</span></div>
      </div>
    </div>

    ${bank}
    ${config.footerNote ? `<div class="muted" style="text-align:center;border-top:1px solid #f3f4f6;padding-top:12px;">${esc(config.footerNote)}</div>` : ""}
  </div></body></html>`;
}

export function buildReceiptHtml({ config = {}, logoUrl, data }) {
  const color = config.primaryColor || FALLBACK_COLOR;
  const b = config.business || {};
  const items = data.items || [];
  const tax = Number(data.tax || 0);
  const { subtotal, total } = computeTotals(items, tax);

  const rows = items
    .map(
      (i) => `
      <div class="row" style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:15px;">
        <span style="color:#374151;font-weight:500;">${esc(i.qty)} &times; ${esc(i.name)}</span>
        <span style="font-weight:700;color:#111827;">${money(i.qty * i.price)}</span>
      </div>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyles(color)}</style></head>
  <body><div class="wrap" style="max-width:560px;font-size:15px;">
    <div style="text-align:center;margin-bottom:22px;">
      ${
        logoUrl
          ? `<img src="${esc(logoUrl)}" style="width:64px;height:64px;border-radius:12px;object-fit:cover;margin:0 auto 10px;display:block;" />`
          : `<div class="accent accent-bg" style="width:60px;height:60px;border-radius:12px;margin:0 auto 10px;line-height:60px;font-weight:800;font-size:26px;">${esc((b.name || "S").charAt(0))}</div>`
      }
      <div style="font-weight:800;font-size:22px;letter-spacing:-.01em;">${esc(b.name || "Your Business Name")}</div>
      <div class="muted" style="font-size:13px;margin-top:3px;">${esc(b.address || "")}</div>
      <div class="muted" style="font-size:13px;">${esc(b.phone || "")}</div>
    </div>

    <div style="border-top:2px dashed #e5e7eb;margin-bottom:16px;"></div>
    <div class="row" style="font-size:13px;margin-bottom:16px;font-weight:600;color:#6b7280;">
      <span>Receipt #${esc(data.docNumber)}</span><span>${esc(data.issueDate)}</span>
    </div>

    ${
      data.customer?.name
        ? `<div style="margin-bottom:16px;">
             <div class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Billed To</div>
             <div style="font-weight:700;font-size:16px;color:#111827;">${esc(data.customer.name)}</div>
             ${data.customer.phone ? `<div class="muted" style="font-size:14px;">${esc(data.customer.phone)}</div>` : ""}
             ${data.customer.email ? `<div class="muted" style="font-size:14px;">${esc(data.customer.email)}</div>` : ""}
           </div>`
        : ""
    }

    <div style="margin-bottom:14px;">${rows}</div>

    <div class="row muted" style="padding:3px 0;font-size:14px;"><span>Subtotal</span><span>${money(subtotal)}</span></div>
    ${tax ? `<div class="row muted" style="padding:3px 0;font-size:14px;"><span>Tax</span><span>${money(tax)}</span></div>` : ""}
    <div class="row accent" style="font-weight:800;font-size:21px;padding:8px 0;border-top:2px solid #e5e7eb;margin-top:6px;"><span>TOTAL</span><span>${money(total)}</span></div>
    <div style="border-top:2px dashed #e5e7eb;margin:14px 0 20px;"></div>

    <div style="text-align:center;">
      <div style="font-weight:700;font-size:16px;margin-bottom:6px;">${esc(config.thankYouMessage || "Thank you for your purchase!")}</div>
      ${config.returnPolicy ? `<div class="muted" style="font-size:12px;line-height:1.6;">${esc(config.returnPolicy)}</div>` : ""}
    </div>
    ${config.showBarcode ? barcodeHtml(data.docNumber) : ""}
  </div></body></html>`;
}
