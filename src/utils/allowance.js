// The free-allowance bucket on a Credits row (Phase 0.3 of the platform plan).
//
// A charge draws on the allowance first and takes whatever is left from the
// purchased balance, in ONE conditional update. That is what lets the
// frontend treat "available = free left + balance" as a single number
// everywhere it gates, and keeps two racing searches from both spending the
// last free credit.
//
// Nothing resets on a schedule. A period is "current" when its periodStart is
// on or after the period boundary; anything older reads as untouched, and the
// next charge starts a fresh period.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** West Africa Time is UTC+1 all year (no DST), so midnight in Lagos is a
 *  fixed offset rather than a timezone lookup. */
const LAGOS_OFFSET_MS = HOUR_MS;

/**
 * boundary — a periodStart on or after this is the current period.
 * newStart — the periodStart a charge writes when it opens a new period.
 * length   — how long a period lasts once started.
 */
export function allowancePeriod(policy, now = new Date()) {
  if (policy.kind === "daily") {
    const shifted = now.getTime() + LAGOS_OFFSET_MS;
    const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS - LAGOS_OFFSET_MS;
    return {
      boundary: new Date(dayStart),
      newStart: new Date(dayStart),
      length: DAY_MS,
    };
  }
  // A rolling window opens at the first spend after the last one expired.
  const length = policy.windowHours * HOUR_MS;
  return {
    boundary: new Date(now.getTime() - length + 1),
    newStart: now,
    length,
  };
}

/** What the meter reads. Null when the actor's tier has no allowance. */
export function summarizeAllowance(row, policy, now = new Date()) {
  if (!policy) return null;
  const { boundary, length } = allowancePeriod(policy, now);
  const start = row?.allowance?.periodStart
    ? new Date(row.allowance.periodStart)
    : null;
  const current = Boolean(start && start >= boundary);
  const used = current ? (row?.allowance?.used ?? 0) : 0;

  let resetsAt = null;
  if (policy.kind === "daily") {
    resetsAt = new Date(boundary.getTime() + length);
  } else if (current) {
    resetsAt = new Date(start.getTime() + length);
  }

  return {
    kind: policy.kind,
    credits: policy.credits,
    eligible: policy.eligible,
    reason: policy.reason ?? null,
    used: policy.eligible ? used : 0,
    remaining: policy.eligible ? Math.max(0, policy.credits - used) : 0,
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
  };
}

function isCurrentExpr(boundary) {
  return {
    $gte: [{ $ifNull: ["$allowance.periodStart", new Date(0)] }, boundary],
  };
}

function remainingExpr(policy, boundary) {
  return {
    $cond: [
      isCurrentExpr(boundary),
      {
        $max: [
          0,
          {
            $subtract: [policy.credits, { $ifNull: ["$allowance.used", 0] }],
          },
        ],
      },
      policy.credits,
    ],
  };
}

/** Filter + update pipeline for a charge of `cost` split allowance-first. */
export function allowanceChargeOps(policy, cost, now = new Date()) {
  const { boundary, newStart } = allowancePeriod(policy, now);
  const remaining = remainingExpr(policy, boundary);
  const fromBalance = { $subtract: [cost, "$_fromA"] };

  const filterExpr = {
    $gte: [{ $add: [{ $ifNull: ["$balance", 0] }, remaining] }, cost],
  };

  const pipeline = [
    {
      $set: {
        _cur: isCurrentExpr(boundary),
        _fromA: { $min: [remaining, cost] },
      },
    },
    {
      $set: {
        balance: { $subtract: [{ $ifNull: ["$balance", 0] }, fromBalance] },
        totalSpent: { $add: [{ $ifNull: ["$totalSpent", 0] }, fromBalance] },
        spentSinceTopUp: {
          $add: [{ $ifNull: ["$spentSinceTopUp", 0] }, fromBalance],
        },
        totalFreeSpent: {
          $add: [{ $ifNull: ["$totalFreeSpent", 0] }, "$_fromA"],
        },
        allowance: {
          $cond: [
            "$_cur",
            {
              periodStart: "$allowance.periodStart",
              used: { $add: [{ $ifNull: ["$allowance.used", 0] }, "$_fromA"] },
            },
            { periodStart: newStart, used: "$_fromA" },
          ],
        },
        lastCharge: { fromAllowance: "$_fromA", fromBalance, at: now },
      },
    },
    { $unset: ["_cur", "_fromA"] },
  ];

  return { filterExpr, pipeline };
}

/**
 * Filter + update pipeline for refunding `cost`. Free credits go back to the
 * allowance, bounded by what the LAST charge actually took from it and by
 * what the current period has used. Only the remainder goes back to the
 * purchased balance, with the same "never more than was spent" guard the
 * balance-only refund has always had.
 *
 * `policy` null (no allowance tier) refunds everything to the balance.
 */
export function refundOps(policy, cost, now = new Date()) {
  const toAllowance = policy
    ? (() => {
        const { boundary } = allowancePeriod(policy, now);
        return {
          $cond: [
            isCurrentExpr(boundary),
            {
              $min: [
                cost,
                { $ifNull: ["$lastCharge.fromAllowance", 0] },
                { $ifNull: ["$allowance.used", 0] },
              ],
            },
            0,
          ],
        };
      })()
    : 0;
  const toBalance = { $subtract: [cost, "$_toA"] };

  const filterExpr = {
    $gte: [{ $ifNull: ["$totalSpent", 0] }, { $subtract: [cost, toAllowance] }],
  };

  const pipeline = [
    { $set: { _toA: toAllowance } },
    {
      $set: {
        balance: { $add: [{ $ifNull: ["$balance", 0] }, toBalance] },
        totalSpent: { $subtract: [{ $ifNull: ["$totalSpent", 0] }, toBalance] },
        // Left to float (floored at 0) rather than gating the refund: it only
        // feeds the meter. totalSpent's filter is what stops minting.
        spentSinceTopUp: {
          $max: [
            0,
            { $subtract: [{ $ifNull: ["$spentSinceTopUp", 0] }, toBalance] },
          ],
        },
        "allowance.used": {
          $max: [0, { $subtract: [{ $ifNull: ["$allowance.used", 0] }, "$_toA"] }],
        },
        totalFreeSpent: {
          $max: [0, { $subtract: [{ $ifNull: ["$totalFreeSpent", 0] }, "$_toA"] }],
        },
        // Spent once, so a second refund of the same charge can't put the
        // same free credits back twice.
        "lastCharge.fromAllowance": {
          $max: [
            0,
            {
              $subtract: [
                { $ifNull: ["$lastCharge.fromAllowance", 0] },
                "$_toA",
              ],
            },
          ],
        },
      },
    },
    { $unset: ["_toA"] },
  ];

  return { filterExpr, pipeline };
}
