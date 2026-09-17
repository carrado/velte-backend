import ShoppingListJob from "../models/ShoppingListJob.model.js";
import { consumeCreditsAtomic } from "../controllers/credits/credits.controller.js";
import { notifyOwner } from "../services/pushNotification.service.js";

// Shopping Lists (2026-09-12) — the durable background search loop behind
// "Get these items".
//
// WHY THIS LIVES HERE, not as a Next.js `after()` callback (which is how
// the frontend's OWN search machinery already works, and how the earlier,
// now-retired Shopping Plan feature ran its background resolution): this
// backend process is the one that's actually always-on (see
// initializers/keepAlive.js's own comment — Render's free tier sleeps/
// recycles an idle instance, which is exactly the frontend's serverless
// runtime, not this one). A `setTimeout`/`after()` block dies with the
// process that scheduled it; a Mongo document polled by a `setInterval`
// here does not. Same idiom as every other sweep in src/jobs/ —
// buyerRequestNotifications.job.js is the closest sibling.
//
// The actual SEARCH LOGIC deliberately does NOT move here. searchProductsCore
// and the Serper external connector are frontend-only code with real
// dependencies (location resolution, budget filtering, the curated
// merchant list) — reimplementing any of that on this side would duplicate
// exactly the machinery the spec says to reuse. Instead, this sweep makes
// one short-lived, shared-secret-authenticated HTTP call per tick into a
// thin Next.js route that wraps those existing functions and returns a
// plain result — the same shape as this backend's own call to
// staffly-ai-backend's internal matching endpoint (matchingClient.service.js),
// just for a new leg (this backend → the frontend), with its OWN secret
// rather than reusing that one — a leak on one internal channel must not
// compromise the other.

const TICK_MS = 20_000;
/** Jobs advanced per tick, network-wide — a natural ceiling on how many
 *  external (Serper) calls this sweep can trigger in one pass. */
const JOBS_PER_TICK = 5;
/** Consecutive failures tolerated on ONE item before it's marked `failed`
 *  and the job moves on — one bad item must never stall the whole list
 *  (spec §35). */
const MAX_ITEM_RETRIES = 3;
const SEARCH_TIMEOUT_MS = 15_000;

// Mirrors CREDIT_COST.shopping_list_item in velte's src/lib/credits.ts —
// same convention as LEAD_COST_KOBO/leadPricing.js: a price constant that
// has to agree across the two repos, kept in sync by comment rather than a
// shared import, since credits.controller.js's own rule is that this
// backend never decides what anything costs, only whether the balance
// covers it. Keep this literal in step if that one ever changes.
const PER_ITEM_COST = 3;

// Exactly one of buyerId/vendorId is ever set on a job (2026-09-17 — see the
// model's own comment) — this is the one place that turns that into the
// `(ownerId, ownerType)` shape consumeCreditsAtomic/notifyOwner already
// expect generically.
function ownerOf(job) {
  return job.buyerId
    ? { ownerId: job.buyerId, ownerType: "buyer" }
    : { ownerId: job.vendorId, ownerType: "vendor" };
}

function frontendUrl() {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return base || null;
}

/**
 * Best-effort call into the frontend's thin wrapper around appendSearchTurn
 * — appends a SUMMARY (never the actual results, see that route's own
 * header) onto the conversation this job was started from, so the buyer
 * sees completion right there in the thread, not only via the notification.
 * Never throws — a failure here must never affect the job's own already-
 * saved status, same tolerance as notifyOwner just above it.
 */
async function notifyConversationComplete(job, { anyFound, foundCount }) {
  const base = frontendUrl();
  const secret = process.env.SHOPPING_LIST_INTERNAL_SECRET;
  if (!base || !secret || !job.conversationId || !job.deviceId) return;
  try {
    await fetch(`${base}/api/internal/shopping-list/notify-complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-shopping-list-internal-secret": secret,
      },
      body: JSON.stringify({
        conversationId: job.conversationId,
        deviceId: job.deviceId,
        buyerId: job.buyerId?.toString?.() ?? null,
        vendorId: job.vendorId?.toString?.() ?? null,
        goalText: job.goalText,
        totalItems: job.totalItems,
        foundCount,
        anyFound,
      }),
    });
  } catch (err) {
    console.error(
      `[shopping-list] conversation summary for job ${job._id} failed:`,
      err?.message ?? err,
    );
  }
}

/**
 * Calls the frontend's thin internal wrapper around searchProductsCore /
 * the Serper connector for ONE item. Never throws for an ordinary "found
 * nothing" outcome — only for a genuine transport/auth failure, which the
 * sweep's own retry logic handles.
 */
async function searchItemViaFrontend(item, location) {
  const base = frontendUrl();
  const secret = process.env.SHOPPING_LIST_INTERNAL_SECRET;
  if (!base || !secret) {
    throw new Error(
      "FRONTEND_URL / SHOPPING_LIST_INTERNAL_SECRET not configured",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/internal/shopping-list/search-item`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-shopping-list-internal-secret": secret,
      },
      body: JSON.stringify({
        itemLabel: item.label,
        location,
        maxBudgetNaira: item.fairPriceMaxNaira || item.estimatedPriceNaira,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`search-item responded ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function advanceOneItem(job) {
  const item = job.items[job.nextItemIndex];
  item.status = "searching";
  item.attemptedAt = new Date();
  await job.save();

  const result = await searchItemViaFrontend(item, job.location);

  if (result?.source === "velte" && result.results?.length) {
    item.velteResults = result.results;
    item.status = "found_velte";
  } else if (result?.source === "external" && result.offers?.length) {
    item.externalOffers = result.offers;
    item.status = "found_external";
  } else {
    item.status = "no_match";
  }

  // Charged AFTER the attempt actually completed — found, or a genuine
  // confirmed no-match, both count as delivered work (same precedent as an
  // ordinary text/photo search that returns zero results still being
  // billable). Never charged for an item the job doesn't reach. Owner is
  // whichever of buyer/vendor this job actually belongs to (2026-09-17) —
  // see ownerOf's own comment.
  const { ownerId, ownerType } = ownerOf(job);
  const charge = await consumeCreditsAtomic(ownerId, ownerType, PER_ITEM_COST);
  item.charged = charge.allowed;
  item.creditsCharged = charge.allowed ? PER_ITEM_COST : 0;
  job.creditsChargedTotal += item.creditsCharged;

  job.nextItemIndex += 1;
  job.failureStreak = 0;
}

async function finishIfDone(job) {
  if (job.nextItemIndex < job.totalItems) return;

  const anyFound = job.items.some(
    (i) => i.status === "found_velte" || i.status === "found_external",
  );
  const anyFailed = job.items.some((i) => i.status === "failed");
  job.status = anyFound && !anyFailed ? "completed" : "completed_partial";
  job.notifiedAt = new Date();

  const foundCount = job.items.filter(
    (i) => i.status === "found_velte" || i.status === "found_external",
  ).length;

  try {
    await notifyOwner(
      ownerOf(job),
      {
        title: anyFound ? "Shopping list ready" : "Shopping list search finished",
        body: anyFound
          ? `Found options for ${foundCount} of ${job.totalItems} items on "${job.goalText}".`
          : `Nothing matched this time on "${job.goalText}" — take a look at what was checked.`,
        url: `/chat/shopping-list/${job._id}`,
        type: "shopping-list",
        metadata: { jobId: job._id.toString() },
      },
    );
  } catch (err) {
    // Best-effort, same as every other notifyOwner call site — the job's
    // own status is what matters and is already saved; a notification
    // hiccup costs only the ping, not the buyer's results.
    console.error(
      `[shopping-list] notify for job ${job._id} failed:`,
      err?.message ?? err,
    );
  }

  await notifyConversationComplete(job, { anyFound, foundCount });
}

export async function processShoppingListJobs() {
  const jobs = await ShoppingListJob.find({
    status: { $in: ["queued", "running"] },
    $expr: { $lt: ["$nextItemIndex", "$totalItems"] },
  })
    .sort({ updatedAt: 1 })
    .limit(JOBS_PER_TICK);

  let advanced = 0;

  for (const job of jobs) {
    try {
      if (job.status === "queued") job.status = "running";
      await advanceOneItem(job);
      await finishIfDone(job);
      advanced += 1;
    } catch (err) {
      job.failureStreak += 1;
      console.error(
        `[shopping-list] job ${job._id} item ${job.nextItemIndex} failed (streak ${job.failureStreak}):`,
        err?.message ?? err,
      );
      if (job.failureStreak >= MAX_ITEM_RETRIES) {
        // Give up on THIS item only — the list keeps moving (spec §35).
        const item = job.items[job.nextItemIndex];
        if (item) item.status = "failed";
        job.nextItemIndex += 1;
        job.failureStreak = 0;
        try {
          await finishIfDone(job);
        } catch (finishErr) {
          console.error(
            `[shopping-list] finishIfDone after giving up on job ${job._id} failed:`,
            finishErr?.message ?? finishErr,
          );
        }
      }
    }
    await job.save().catch((err) =>
      console.error(`[shopping-list] save for job ${job._id} failed:`, err?.message ?? err),
    );
  }

  if (advanced) {
    console.log(`[shopping-list] advanced ${advanced} job(s) this tick`);
  }
  return advanced;
}

export function startShoppingListJobsCron() {
  const run = () => {
    processShoppingListJobs().catch((err) =>
      console.error("[shopping-list] sweep failed:", err?.message ?? err),
    );
  };
  const timer = setInterval(run, TICK_MS);
  timer.unref();
  console.log(`[shopping-list] background search sweep every ${TICK_MS / 1000}s`);
}
