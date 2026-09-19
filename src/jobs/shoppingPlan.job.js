import crypto from "crypto";

import ShoppingPlan from "../models/ShoppingPlan.model.js";
import Buyer from "../models/Buyer.model.js";
import { consumeCreditsAtomic } from "../controllers/credits/credits.controller.js";
import { notifyOwner } from "../services/pushNotification.service.js";
import { sendSms } from "../services/sendchamp.service.js";

// Shopping Plan (2026-09-18, adaptive monitoring + alternatives added
// 2026-09-19/Phase 2) — the recurring background-monitoring sweep behind a
// deadline-driven plan. Built on the same cross-service shape the deleted
// ShoppingListJob already proved out (see that job's own git history), but
// RECURRING rather than one-shot: this plan keeps monitoring until the
// buyer completes it, pauses it, cancels it, or its deadline passes —
// ShoppingListJob searched each item once and was done.
//
// WHY THIS LIVES HERE, not as a Next.js route/`after()` callback: this
// backend process is the one that's actually always-on (Render's free tier
// sleeps/recycles an idle instance, which is exactly the frontend's
// serverless runtime, not this one — see initializers/keepAlive.js). The
// actual SEARCH LOGIC deliberately does NOT move here — searchProductsCore
// and the Serper connector are frontend-only code with real dependencies
// (location resolution, budget filtering, item-kind verification);
// reimplementing any of it here would duplicate exactly the machinery this
// is supposed to reuse. Instead this sweep makes one short-lived,
// shared-secret-authenticated HTTP call per item into a thin Next.js route
// that wraps those functions and returns a normalized result.
//
// PHASE 2 — the internal check cadence and the user-facing digest cadence
// are now DECOUPLED (spec §18: "internal search frequency can change
// independently" of the ~24h update cadence). `nextMonitorAt` governs when
// this sweep next TOUCHES the plan at all (an adaptive interval, tighter
// as the deadline nears); `lastDigestAt` separately governs when a digest
// last actually SENT. A plan whose internal interval has dropped below 24h
// gets checked every tick without a new digest each time — the digest
// aggregate is computed by SCANNING each candidate's own timestamped
// price/availability history for entries newer than `lastDigestAt` (see
// computeDigestAggregate), rather than an incrementally-summed counter, so
// it stays a pure function of already-persisted state: safe to recompute
// on a crash retry with no double-counting risk, and nothing new to keep
// in sync.

const TICK_MS = 5 * 60 * 1000; // 5 min — well under the tightest per-plan interval tier below.
const PLANS_PER_TICK = 10;
const SEARCH_TIMEOUT_MS = 15_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Mirrors CREDIT_COST.shopping_plan_check in velte's src/lib/credits.ts —
// same convention as PER_ITEM_COST in the deleted shoppingListJob.job.js: a
// price constant that has to agree across the two repos, kept in sync by
// comment rather than a shared import, since credits.controller.js's own
// rule is that this backend never decides what anything costs, only
// whether the balance covers it.
const PER_ITEM_CHECK_COST = 3;

// Adaptive monitoring tiers (spec §18) — the INTERNAL check frequency only.
// The digest itself still only sends once every DAY_MS at most, enforced
// separately in runMonitoringCycle via lastDigestAt.
const INTERVAL_TIERS = [
  { minDays: 30, hours: 96 }, // "periodic" — every 4 days
  { minDays: 14, hours: 72 }, // "every 2-3 days"
  { minDays: 7, hours: 24 }, // daily
  { minDays: 3, hours: 24 }, // daily, stronger focus on obtainable options (see orderItemsByUrgency)
  { minDays: -Infinity, hours: 12 }, // 1-2 days out — prioritize what's obtainable before the deadline
];

function intervalHoursFor(daysRemaining) {
  const tier = INTERVAL_TIERS.find((t) => daysRemaining >= t.minDays);
  return tier ? tier.hours : 24;
}

// Configurable per spec §9 ("the exact thresholds should be configurable")
// — named constants rather than the values inlined at their one call site,
// so tuning them later doesn't mean hunting through the function body.
const WITHIN_BUDGET_MAX_RATIO = 1.0; // at or under budget
const SIGNIFICANTLY_OVER_BUDGET_RATIO = 1.25; // 25%+ over budget is "significant"; anything between the two ratios is "slight"

function daysRemaining(deadlineDate, now) {
  const deadlineUtc = Date.UTC(
    deadlineDate.getUTCFullYear(),
    deadlineDate.getUTCMonth(),
    deadlineDate.getUTCDate(),
  );
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((deadlineUtc - nowUtc) / DAY_MS);
}

function ownerOf(plan) {
  return plan.buyerId
    ? { ownerId: plan.buyerId, ownerType: "buyer" }
    : { ownerId: plan.vendorId, ownerType: "vendor" };
}

function frontendUrl() {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return base || null;
}

function formatNaira(n) {
  return `₦${Math.round(n).toLocaleString("en-NG")}`;
}

/**
 * Calls the frontend's thin internal wrapper around searchProductsCore /
 * the Serper connector for ONE item. Throws only on a genuine transport/
 * auth failure — an ordinary "found nothing" outcome is a normal response,
 * not an error, same contract the deleted shoppingListJob.job.js followed.
 */
async function searchItemViaFrontend(item, location, planBudgetNaira) {
  const base = frontendUrl();
  const secret = process.env.SHOPPING_PLAN_INTERNAL_SECRET;
  if (!base || !secret) {
    throw new Error("FRONTEND_URL / SHOPPING_PLAN_INTERNAL_SECRET not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/internal/shopping-plan/search-item`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-shopping-plan-internal-secret": secret,
      },
      body: JSON.stringify({
        itemLabel: item.label,
        // No per-item estimate exists any more to filter by (removed
        // 2026-09-19) — the plan's own real, buyer-stated budget is the only
        // figure left, used as a soft ceiling. Coarser than a true per-item
        // budget on a multi-item plan, but safe: it only ever EXCLUDES
        // options priced above what the buyer said they'd spend overall,
        // never a genuinely affordable one.
        maxBudgetNaira: planBudgetNaira || undefined,
        location,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`search-item responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function latestPrice(candidate) {
  return candidate.priceHistory.length
    ? candidate.priceHistory[candidate.priceHistory.length - 1].priceNaira
    : null;
}

function latestAvailable(candidate) {
  return candidate.availabilityHistory.length
    ? candidate.availabilityHistory[candidate.availabilityHistory.length - 1].available
    : true;
}

/**
 * Picks a replacement for an item's SELECTED candidate once it's gone —
 * the cheapest still-available candidate other than the stale one.
 * Deliberately simple arithmetic, not an LLM call (pickRecommendation):
 * this runs inside the background sweep's own hot path across every item
 * of every due plan, and "cheapest available" is a correct, defensible
 * answer to "what should replace the one that disappeared" without adding
 * model latency/cost to a job that already makes one HTTP call per item.
 */
function pickAlternativeCandidate(item, staleCandidateId) {
  let best = null;
  for (const c of item.candidates) {
    if (c._id.equals(staleCandidateId)) continue;
    if (!latestAvailable(c)) continue;
    const price = latestPrice(c);
    if (price == null) continue;
    if (!best || price < latestPrice(best)) best = c;
  }
  return best;
}

/**
 * Applies one item's fresh candidate list against its stored history.
 * Never overwrites a history array in place — an entry is appended only
 * when the price/availability actually changed since the last check, so
 * the array itself IS the history (spec §16), and re-running this against
 * unchanged data is a no-op (what makes a crash-and-retry of a cycle safe).
 *
 * Phase 2: also detects the SELECTED candidate going unavailable and
 * suggests a replacement (spec §20) — never auto-applied, see the model's
 * own comment on suggestedAlternativeCandidateId.
 */
function diffItemCandidates(item, freshCandidates, now) {
  const freshKeys = new Set(freshCandidates.map((f) => f.candidateKey));

  for (const fresh of freshCandidates) {
    const existing = item.candidates.find((c) => c.candidateKey === fresh.candidateKey);
    if (!existing) {
      item.candidates.push({
        candidateKey: fresh.candidateKey,
        source: fresh.source,
        snapshot: fresh.snapshot,
        firstDiscoveredAt: now,
        lastCheckedAt: now,
        priceHistory:
          fresh.priceNaira != null ? [{ priceNaira: fresh.priceNaira, checkedAt: now }] : [],
        availabilityHistory: [{ available: fresh.available !== false, checkedAt: now }],
      });
      continue;
    }

    existing.lastCheckedAt = now;
    existing.snapshot = fresh.snapshot; // refresh display data (image/title/etc may change)

    const lastPrice = latestPrice(existing);
    if (fresh.priceNaira != null && fresh.priceNaira !== lastPrice) {
      existing.priceHistory.push({ priceNaira: fresh.priceNaira, checkedAt: now });
    }

    const lastAvailable = latestAvailable(existing);
    const nowAvailable = fresh.available !== false;
    if (nowAvailable !== lastAvailable) {
      existing.availabilityHistory.push({ available: nowAvailable, checkedAt: now });
    }
  }

  // A Velte/external listing that goes away doesn't come back flagged
  // `available: false` — it just stops being RETURNED by the search at
  // all (a suspended product is excluded at the DB layer, not marked).
  // So absence from this cycle's fresh results is itself the signal.
  //
  // Known tradeoff: the search only returns a capped top-N per item, so a
  // still-available candidate that merely ranked outside that window this
  // cycle looks identical to a genuinely gone one and would be flagged
  // unavailable too. Accepted for now (the internal route returns a
  // generous cap to reduce how often this happens) rather than adding a
  // multi-cycle "missing streak" confirmation before flagging.
  for (const existing of item.candidates) {
    if (freshKeys.has(existing.candidateKey)) continue;
    if (latestAvailable(existing)) {
      existing.availabilityHistory.push({ available: false, checkedAt: now });
    }
  }

  // Alternatives with approval (spec §20) — only when the candidate that
  // JUST went unavailable this pass is the one the buyer actually
  // selected; a candidate nobody picked disappearing is an ordinary,
  // silent history update, not something worth interrupting the buyer
  // over. Never overwrites an alternative already awaiting the buyer's own
  // approval/dismissal.
  if (item.selectedCandidateId && !item.suggestedAlternativeCandidateId) {
    const selected = item.candidates.id(item.selectedCandidateId);
    if (selected && !latestAvailable(selected)) {
      const alternative = pickAlternativeCandidate(item, item.selectedCandidateId);
      if (alternative) item.suggestedAlternativeCandidateId = alternative._id;
    }
  }

  item.lastCheckedAt = now;
  item.status = item.candidates.length ? "found" : "no_match";
}

/** The cheapest currently-available REAL price for an item — the buyer's
 *  own selected candidate if they made one, else the lowest available price
 *  seen, else 0 (no real candidate found for this item yet — never a
 *  model-invented placeholder; estimatedPriceNaira stopped being populated
 *  2026-09-19, see buildShoppingPlanSnapshot.ts). An item contributing 0
 *  here undercounts estimatedTotalNaira rather than overstating it with a
 *  guess. */
function currentPriceForItem(item) {
  if (item.selectedCandidateId) {
    const selected = item.candidates.id(item.selectedCandidateId);
    const price = selected ? latestPrice(selected) : null;
    if (price != null) return price;
  }
  let cheapest = null;
  for (const c of item.candidates) {
    if (!latestAvailable(c)) continue;
    const price = latestPrice(c);
    if (price != null && (cheapest == null || price < cheapest)) cheapest = price;
  }
  return cheapest ?? 0;
}

// Phase 3 (2026-09-19) — a `removed` item (conversational "I don't need
// sportswear anymore") drops out of every total/search/digest below, but
// its own row and history stay on the document (see the model's own
// comment on why this is a flag, not a splice).
function activeItems(plan) {
  return plan.items.filter((item) => !item.removed);
}

function estimatedTotalNaira(plan) {
  return activeItems(plan).reduce((sum, item) => sum + currentPriceForItem(item) * item.quantity, 0);
}

/** Sum of what's ACTUALLY been bought — real user action, never inferred
 *  (spec §28). */
function spentTotalNaira(plan) {
  return activeItems(plan).reduce(
    (sum, item) => sum + (item.purchased ? (item.purchasedPriceNaira ?? 0) : 0),
    0,
  );
}

/** Sum of the buyer's own picks, whether or not bought yet — distinct
 *  from the estimate (spec §8's four values: budget/estimated/selected/
 *  spent). Falls back to nothing for an item with no selection. */
function selectedTotalNaira(plan) {
  return activeItems(plan).reduce((sum, item) => {
    if (!item.selectedCandidateId) return sum;
    const selected = item.candidates.id(item.selectedCandidateId);
    const price = selected ? latestPrice(selected) : null;
    return sum + (price ?? 0) * item.quantity;
  }, 0);
}

function budgetStatusFor(plan, currentEstimateNaira) {
  if (!plan.budgetNaira) return null;
  const ratio = currentEstimateNaira / plan.budgetNaira;
  if (ratio <= WITHIN_BUDGET_MAX_RATIO) return "within_budget";
  return ratio >= SIGNIFICANTLY_OVER_BUDGET_RATIO
    ? "significantly_over_budget"
    : "slightly_over_budget";
}

/**
 * The digest aggregate since a given instant — a pure read over each
 * candidate's own timestamped history, never an incrementally-maintained
 * counter (see this file's own top comment on why: idempotent to
 * recompute on a crash retry with zero double-counting risk).
 */
function computeDigestAggregate(plan, sinceDate) {
  let newOptions = 0;
  let priceDrops = 0;
  let priceIncreases = 0;
  let unavailable = 0;

  for (const item of activeItems(plan)) {
    for (const c of item.candidates) {
      if (c.firstDiscoveredAt > sinceDate) newOptions += 1;

      for (let i = 1; i < c.priceHistory.length; i++) {
        const cur = c.priceHistory[i];
        if (cur.checkedAt <= sinceDate) continue;
        const prev = c.priceHistory[i - 1];
        if (cur.priceNaira < prev.priceNaira) priceDrops += 1;
        else if (cur.priceNaira > prev.priceNaira) priceIncreases += 1;
      }

      for (let i = 1; i < c.availabilityHistory.length; i++) {
        const cur = c.availabilityHistory[i];
        if (cur.checkedAt <= sinceDate) continue;
        const prev = c.availabilityHistory[i - 1];
        if (prev.available && !cur.available) unavailable += 1;
      }
    }
  }

  return { newOptions, priceDrops, priceIncreases, unavailable };
}

function cycleHasMeaningfulChange(cycle) {
  return (
    cycle.newOptions > 0 ||
    cycle.priceDrops > 0 ||
    cycle.priceIncreases > 0 ||
    cycle.unavailable > 0
  );
}

/** Items with no suitable option yet, ranked-selected-first is nothing to
 *  report on again — used both for urgency ordering and for the
 *  deadline-approaching digest line (spec §19). */
function itemsNeedingAttention(plan) {
  return activeItems(plan).filter((i) => !i.selectedCandidateId && i.status !== "searching");
}

function digestBody(plan, cycle, daysLeft) {
  const parts = [];
  if (cycle.newOptions > 0)
    parts.push(`${cycle.newOptions} new option${cycle.newOptions === 1 ? "" : "s"}`);
  if (cycle.priceDrops > 0)
    parts.push(`${cycle.priceDrops} price drop${cycle.priceDrops === 1 ? "" : "s"}`);
  if (cycle.priceIncreases > 0)
    parts.push(`${cycle.priceIncreases} price increase${cycle.priceIncreases === 1 ? "" : "s"}`);
  if (cycle.unavailable > 0)
    parts.push(`${cycle.unavailable} item${cycle.unavailable === 1 ? "" : "s"} no longer available`);

  let body = parts.length
    ? `I found ${parts.join(", ")} for "${plan.goalText}".`
    : `Update on "${plan.goalText}".`;

  if (cycle.currentEstimateNaira != null) {
    body += ` Current estimate: ${formatNaira(cycle.currentEstimateNaira)}.`;
  }
  if (cycle.budgetStatus === "slightly_over_budget" || cycle.budgetStatus === "significantly_over_budget") {
    body += ` Your ${formatNaira(plan.budgetNaira)} budget may be underestimated — I'll keep searching for lower-priced options.`;
  }

  // Deadline-approaching content (spec §19) — only once it's genuinely
  // close (the tier the adaptive interval also tightens at), and only
  // ever ADDS to the ordinary update, never replaces it.
  if (daysLeft != null && daysLeft <= 7) {
    const needAttention = itemsNeedingAttention(plan);
    const total = activeItems(plan).length;
    const readyCount = total - needAttention.length;
    body += ` Your deadline is in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. ${readyCount}/${total} items have suitable options.`;
    if (needAttention.length) {
      body += ` I've prioritized currently available options for the rest.`;
    }
  }

  return body;
}

/**
 * Runs every item's search + candidate diff for a due plan. Idempotent to
 * re-run in full (diffing unchanged data is a no-op) — this is what makes
 * a crash-and-retry mid-pass safe without needing its own resumability
 * cursor, same acceptance the deleted ShoppingListJob's simpler cousin
 * made for a much longer-running job.
 *
 * Urgency ordering (spec §18, "3-7"/"1-2 days" tiers: "stronger focus on
 * currently obtainable options") — items with no selection yet are
 * checked FIRST once the deadline is close, so a credit-limited or
 * time-limited pass spends its effort on what still needs attention
 * rather than re-confirming items already settled.
 */
async function checkPlanItems(plan, now, daysLeft) {
  const eligible = activeItems(plan);
  const ordered =
    daysLeft != null && daysLeft <= 7
      ? [...eligible].sort((a, b) => {
          const aNeeds = a.selectedCandidateId ? 0 : 1;
          const bNeeds = b.selectedCandidateId ? 0 : 1;
          return bNeeds - aNeeds || b.priority - a.priority;
        })
      : eligible;

  for (const item of ordered) {
    try {
      item.status = "searching";
      const result = await searchItemViaFrontend(item, plan.location, plan.budgetNaira);
      const freshCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
      diffItemCandidates(item, freshCandidates, now);

      const { ownerId, ownerType } = ownerOf(plan);
      await consumeCreditsAtomic(ownerId, ownerType, PER_ITEM_CHECK_COST);
    } catch (err) {
      // One item's search failing must never fail the whole plan (spec
      // §27) — keep its existing candidates, log, move to the next item.
      console.error(
        `[shopping-plan] plan ${plan._id} item "${item.label}" check failed:`,
        err?.message ?? err,
      );
      item.status = item.candidates.length ? "found" : "failed";
    }
  }
}

/**
 * Runs one due plan: an item check pass at its own adaptive interval, and
 * — only once at least a full day has elapsed since the last one — a
 * digest flush. Crash-safety: the item-check pass (idempotent) always
 * completes and saves BEFORE any digest bookkeeping starts, so a crash
 * partway through digest delivery resumes at the delivery step using the
 * already-frozen `lastCycle`, never re-running the search or
 * recomputing (and potentially double-counting) the aggregate.
 */
async function runMonitoringCycle(plan, now) {
  const daysLeft = daysRemaining(plan.deadlineDate, now);
  const intervalHours = intervalHoursFor(daysLeft);
  plan.monitoringIntervalHours = intervalHours;

  const resumingDigest = Boolean(
    plan.currentMonitoringCycleId &&
      plan.lastCycle?.cycleId === plan.currentMonitoringCycleId &&
      plan.lastCycle.summaryGenerated,
  );

  if (!resumingDigest) {
    await checkPlanItems(plan, now, daysLeft);
    await plan.save();
  }

  const sinceLastDigest = plan.lastDigestAt ?? plan.createdAt;
  const digestDue = now.getTime() - sinceLastDigest.getTime() >= DAY_MS;

  if (digestDue) {
    let cycle;
    if (!resumingDigest) {
      const cycleId = crypto.randomUUID();
      plan.currentMonitoringCycleId = cycleId;
      const aggregate = computeDigestAggregate(plan, sinceLastDigest);
      const currentEstimateNaira = estimatedTotalNaira(plan);
      const previousEstimateNaira = plan.lastDigestEstimateNaira ?? currentEstimateNaira;
      cycle = {
        cycleId,
        cycleStart: sinceLastDigest,
        cycleEnd: now,
        ...aggregate,
        previousEstimateNaira,
        currentEstimateNaira,
        budgetStatus: budgetStatusFor(plan, currentEstimateNaira),
        summaryGenerated: true,
        pushSent: false,
        smsSent: false,
      };
      plan.lastCycle = cycle;
      await plan.save();
    } else {
      cycle = plan.lastCycle;
    }

    if (cycleHasMeaningfulChange(cycle)) {
      const { ownerId, ownerType } = ownerOf(plan);
      const body = digestBody(plan, cycle, daysLeft);

      // Preferences live on Buyer only today (see Buyer.model.js's own
      // notificationPrefs comment) — a vendor-owned plan has no such gate
      // yet, so it defaults to push-on/SMS-off, matching how push already
      // behaves for vendors everywhere else in the app.
      const buyer =
        ownerType === "buyer"
          ? await Buyer.findById(ownerId).select("phone phoneVerified notificationPrefs").lean()
          : null;
      const pushEnabled = ownerType === "vendor" || buyer?.notificationPrefs?.pushEnabled !== false;
      const smsEnabled = ownerType === "buyer" && buyer?.notificationPrefs?.smsEnabled === true;

      // Disabling a channel only disables DELIVERY, never the monitoring
      // itself (spec §14) — marked sent either way so a disabled channel
      // isn't retried forever.
      if (!plan.lastCycle.pushSent) {
        try {
          if (pushEnabled) {
            await notifyOwner(
              { ownerId, ownerType },
              {
                type: "shopping-plan-digest",
                title:
                  daysLeft != null && daysLeft <= 7
                    ? "Shopping Plan Update — deadline approaching"
                    : "Shopping Plan Update",
                body,
                url: `/chat/shopping-plan/${plan._id}`,
                metadata: { planId: plan._id.toString(), cycleId: cycle.cycleId },
              },
            );
          }
          plan.lastCycle.pushSent = true;
          await plan.save();
        } catch (err) {
          console.error(`[shopping-plan] push for plan ${plan._id} failed:`, err?.message ?? err);
        }
      }

      if (!plan.lastCycle.smsSent) {
        try {
          if (smsEnabled && buyer?.phoneVerified && buyer.phone) {
            await sendSms(buyer.phone, `Velte Shopping Plan update: ${body} Open Velte to view details.`);
          }
          plan.lastCycle.smsSent = true;
          await plan.save();
        } catch (err) {
          console.error(`[shopping-plan] sms for plan ${plan._id} failed:`, err?.message ?? err);
        }
      }
    }

    plan.lastDigestAt = now;
    plan.lastDigestEstimateNaira = cycle.currentEstimateNaira;
    plan.currentMonitoringCycleId = null;
  }

  plan.lastMonitoredAt = now;
  plan.nextMonitorAt = new Date(now.getTime() + intervalHours * HOUR_MS + (plan.jitterMs || 0));
  if (plan.status === "active") plan.status = "monitoring";
  await plan.save();
}

export async function processShoppingPlans() {
  const now = new Date();
  const plans = await ShoppingPlan.find({
    status: { $in: ["active", "monitoring"] },
    nextMonitorAt: { $lte: now },
  })
    .sort({ nextMonitorAt: 1 })
    .limit(PLANS_PER_TICK);

  let processed = 0;
  for (const plan of plans) {
    try {
      if (plan.deadlineDate && plan.deadlineDate.getTime() < now.getTime()) {
        plan.status = "expired";
        await plan.save();
        continue;
      }
      await runMonitoringCycle(plan, now);
      processed += 1;
    } catch (err) {
      console.error(`[shopping-plan] cycle for plan ${plan._id} failed:`, err?.message ?? err);
      // Push the schedule forward regardless — a plan stuck failing every
      // cycle must not spin the sweep every tick forever (same reasoning as
      // every other sweep's per-record try/catch here).
      try {
        plan.nextMonitorAt = new Date(now.getTime() + DAY_MS + (plan.jitterMs || 0));
        await plan.save();
      } catch (saveErr) {
        console.error(`[shopping-plan] failed to reschedule plan ${plan._id}:`, saveErr?.message ?? saveErr);
      }
    }
  }

  if (processed) {
    console.log(`[shopping-plan] processed ${processed} plan(s) this tick`);
  }
  return processed;
}

export function startShoppingPlanCron() {
  const run = () => {
    processShoppingPlans().catch((err) =>
      console.error("[shopping-plan] sweep failed:", err?.message ?? err),
    );
  };
  // No immediate run on boot — same reasoning as every other sweep here: a
  // redeploy should not fire a wave of monitoring cycles just because the
  // process restarted near a plan's due time.
  const timer = setInterval(run, TICK_MS);
  timer.unref();
  console.log(`[shopping-plan] background monitoring sweep every ${TICK_MS / 60000} min`);
}
