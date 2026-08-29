import PriceWatch from "../models/PriceWatch.model.js";
import Product from "../models/Product.model.js";
import { findWatchOwner } from "../helpers/watchOwner.js";
import { notifyPriceDrop } from "../helpers/priceDropAlert.js";

// The price-watch sweep (2026-08-29). Runs both halves of the feature.
//
// WHY THERE ARE TWO HALVES: re-reading a Jumia/Konga/Jiji price means
// parsing that page, and the only implementation of that lives in the
// frontend (connectors/pageMeta.ts) — it is what put the price on the card
// in the first place, and a second parser here would drift from it and start
// disagreeing about what a listing costs. A Velte product's price, by
// contrast, is a column in this repo's own database.
//
//   Velte watches    → checked HERE, one query, no HTTP at all.
//   External watches → the frontend's /api/price-watch/check is pinged, and
//                      it calls back into this repo for the due list and to
//                      report what it found.
//
// SELF-SCHEDULED, no third-party cron (2026-08-29, per explicit request).
// This replaced pointing cron-job.org at the frontend route. Two reasons it
// works better here: this process is already long-lived and already kept
// awake, so it costs nothing extra; and the schedule now lives in the same
// repo as the data it drives, instead of in a web dashboard nobody reading
// this code can see.
//
// The one thing to know: this ping goes over the public internet to Vercel
// and back, so FRONTEND_URL and CRON_SECRET must both be set or the external
// half silently does nothing. That is logged, not swallowed.

// Every 3 hours. Watches become due at 24h (STALE_MS), so a sweep this often
// checks each one within 24–27h of its last check, and drains a backlog
// eight times a day rather than once — which matters because the frontend
// only takes a batch at a time.
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;

// How stale a watch must be before it is re-checked. 24 hours, per explicit
// request: these listings don't reprice faster than daily, every check is an
// outbound request on a free tier, and the alert cooldown is the same length
// — so a watch is checked once a day and can produce at most one alert a
// day, which is the cadence "we'll tell you when it drops" implies.
const STALE_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;

// The external ping crosses the internet; without a cap a hung Vercel
// function would hold this sweep open until the next one was due.
const PING_TIMEOUT_MS = 60_000;

// ── Half 1: Velte's own products ─────────────────────────────────────────
export async function checkVeltePriceWatches() {
  const staleBefore = new Date(Date.now() - STALE_MS);
  const cooldown = new Date(Date.now() - COOLDOWN_MS);

  const watches = await PriceWatch.find({
    kind: "velte",
    status: "active",
    $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: staleBefore } }],
  })
    .sort({ lastCheckedAt: 1 })
    .limit(BATCH);

  if (!watches.length) return;

  let notified = 0;

  for (const watch of watches) {
    try {
      const product = await Product.findById(watch.productId)
        .select("price quoteOnRequest")
        .lean();

      // Gone, or switched to quote-on-request — either way there is no
      // longer a price to compare, so the watch ends rather than sitting
      // active forever being re-queried.
      if (!product || product.quoteOnRequest) {
        watch.status = "ended";
        watch.lastCheckedAt = new Date();
        await watch.save();
        continue;
      }

      // Product.price is NAIRA (see the model); everything here is kobo.
      const current = Math.round(product.price * 100);
      const previous = watch.lastPriceKobo;

      watch.lastCheckedAt = new Date();
      watch.lastPriceKobo = current;

      const hitTarget =
        watch.targetPriceKobo != null && current <= watch.targetPriceKobo;
      const justCheaper = watch.targetPriceKobo == null && current < previous;
      const outOfCooldown =
        !watch.lastNotifiedAt || watch.lastNotifiedAt <= cooldown;

      if ((hitTarget || justCheaper) && outOfCooldown) {
        const owner = await findWatchOwner(watch.ownerId, watch.ownerType);

        // Same two-channel helper the external half uses, so both kinds of
        // watch say the same thing the same way. A Velte product has no
        // outbound url on the watch, so the email simply carries no button
        // rather than a broken one.
        const sent = await notifyPriceDrop({
          owner,
          watch,
          currentKobo: current,
        });
        if (sent) {
          watch.lastNotifiedAt = new Date();
          notified += 1;
        }
      }

      await watch.save();
    } catch (err) {
      // One bad watch must not stop the batch.
      console.error(
        `[price-watch/velte] ${watch._id} failed:`,
        err?.message ?? err,
      );
    }
  }

  if (notified) {
    console.log(
      `[price-watch/velte] checked ${watches.length}, alerted ${notified}`,
    );
  }
}

// ── Half 2: off-Velte listings, via the frontend ─────────────────────────
export async function triggerExternalCheck() {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  const secret = process.env.CRON_SECRET;

  // Logged rather than thrown: a deployment without these configured should
  // run the Velte half perfectly well and say clearly why the other is idle.
  if (!base || !secret) {
    console.warn(
      "[price-watch/external] skipped — FRONTEND_URL and CRON_SECRET must both be set",
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/price-watch/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": secret,
      },
      signal: controller.signal,
    });

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(
        `[price-watch/external] checker returned ${res.status}:`,
        body?.error ?? "(no body)",
      );
      return;
    }
    if (body?.checked) {
      console.log(
        `[price-watch/external] checked ${body.checked}, ${body.dropped ?? 0} dropped, ${body.notified ?? 0} alerted`,
      );
    }
  } catch (err) {
    // Includes the abort above, and a Vercel cold start that took too long.
    // Nothing is lost: no watch was marked checked, so the next sweep picks
    // up exactly the same ones.
    console.error("[price-watch/external] ping failed:", err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
}

export function startPriceWatchCron() {
  const run = () => {
    // Sequential, not parallel: both halves ultimately write to the same
    // collection, and there is no hurry — nothing here is user-facing.
    checkVeltePriceWatches()
      .catch((err) =>
        console.error("[price-watch/velte] sweep failed:", err.message),
      )
      .then(triggerExternalCheck);
  };

  // Same plain-setInterval approach as walletLowBalanceCron — this process
  // is already assumed long-lived, so a periodic tick needs no scheduler and
  // no new dependency.
  //
  // No immediate run on boot, unlike the wallet cron: nobody is harmed by a
  // price drop being noticed a few hours later, and a redeploy firing a wave
  // of email and SMS at every buyer at once is a real risk worth avoiding.
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();

  console.log(
    `[price-watch] sweep every ${CHECK_INTERVAL_MS / 3_600_000}h (watches due after ${STALE_MS / 3_600_000}h)`,
  );
}
