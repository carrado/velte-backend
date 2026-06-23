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
 * colours.
 *
 * Image loading is best-effort and time-boxed: we DON'T wait on `networkidle0`,
 * because a single slow or unreachable remote image (e.g. a merchant's logo on a
 * sluggish host) would otherwise hang the render and throw after the timeout —
 * silently losing the document. Instead we load the markup, then give images a
 * short grace period to settle, and render regardless. A broken logo yields a
 * receipt without the logo, never no receipt at all.
 */
export async function renderPdfFromHtml(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Bounded wait for images: resolves as soon as they all load/error, or after
    // 4s — whichever comes first. Never throws.
    await page
      .evaluate(
        () =>
          Promise.race([
            Promise.all(
              Array.from(document.images).map((img) =>
                img.complete
                  ? Promise.resolve()
                  : new Promise((res) => {
                      img.onload = res;
                      img.onerror = res;
                    }),
              ),
            ),
            new Promise((res) => setTimeout(res, 4000)),
          ]),
      )
      .catch(() => {});

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
