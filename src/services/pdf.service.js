import puppeteer from "puppeteer";

// One shared browser for the process — launching Chromium per request is slow.
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      })
      .catch((err) => {
        browserPromise = null; // allow a later retry if launch failed
        throw err;
      });
  }
  return browserPromise;
}

/**
 * Render an HTML string to a PDF buffer (A4). `printBackground` keeps the brand
 * colours; `networkidle0` waits for the logo image to load.
 */
export async function renderPdfFromHtml(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" },
    });
  } finally {
    await page.close();
  }
}

// Graceful shutdown hook (optional to wire into the server's SIGTERM handler).
export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close();
  }
}
