import PriceWatch from "../../models/PriceWatch.model.js";
import Buyer from "../../models/Buyer.model.js";
import { findWatchOwner } from "../../helpers/watchOwner.js";
import { AppError } from "../../middleware/errorHandler.js";
import { effectivePlanId } from "../../config/buyerPlans.js";
import { notifyPriceDrop } from "../../helpers/priceDropAlert.js";

// Price watches (2026-08-29). See PriceWatch.model.js for the shape and why
// this feature carries the paid tier.
//
// Owned by EITHER kind of account: buyers watch what they want to buy,
// vendors watch competitors. See PriceWatch.model.js.
//
// The watch LIMIT arrives from the caller's plan table, same pattern and
// same reasoning as usage.controller.js: the numbers live in the frontend's
// plans.ts, the account's tier is resolved HERE, and this file picks the row.
// The caller decides what a tier is worth, never which tier applies.

// How stale a watch has to be before it is re-checked. 24 hours, per
// explicit request: these listings don't reprice faster than daily, every
// check is an outbound page fetch on a free tier, and the alert cooldown
// below is the same length — so a watch is checked once a day and can
// produce at most one alert a day, which is the cadence a buyer expects
// from something described as "we'll tell you when it drops".
const STALE_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ── POST /api/price-watch ────────────────────────────────────────────────
//
// Body: { kind, productId?, url?, label, imageUrl?, merchant?, priceKobo,
//         targetPriceKobo?, limits: { free: 0, plus: 20, business: 100 } }
export async function createWatch(req, res, next) {
  try {
    const {
      kind,
      productId,
      url,
      label,
      imageUrl,
      merchant,
      priceKobo,
      targetPriceKobo,
      limits,
    } = req.body ?? {};

    if (kind !== "velte" && kind !== "external") {
      throw new AppError("kind must be 'velte' or 'external'.", 400);
    }
    if (kind === "velte" && !productId) {
      throw new AppError("productId is required for a Velte watch.", 400);
    }
    if (kind === "external" && !url) {
      throw new AppError("url is required for an external watch.", 400);
    }
    if (!label || typeof label !== "string") {
      throw new AppError("label is required.", 400);
    }
    // A watch with no starting price has nothing to compare against later,
    // so "it got cheaper" could never be said honestly. Refused rather than
    // stored as a watch that can never fire.
    if (!Number.isInteger(priceKobo) || priceKobo <= 0) {
      throw new AppError(
        "This listing doesn't show a price, so there's nothing to watch yet.",
        400,
      );
    }
    if (!limits || typeof limits !== "object") {
      throw new AppError("limits must be an object of plan → quota.", 400);
    }

    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const { id: ownerId, type: ownerType } = req.actor;

    // A vendor has no buyer plan to be on — they get the caller's `vendor`
    // row, which exists because watching competitors is a vendor retention
    // feature in its own right, not because they bought a buyer plan.
    let plan;
    if (ownerType === "vendor") {
      plan = Number.isInteger(limits.vendor) ? "vendor" : "free";
    } else {
      const buyer = await Buyer.findById(ownerId)
        .select("plan planExpiresAt")
        .lean();
      if (!buyer) throw new AppError("Account not found.", 404);
      plan = effectivePlanId(buyer);
    }

    const limit = Number.isInteger(limits[plan]) ? limits[plan] : limits.free;
    if (!Number.isInteger(limit)) {
      throw new AppError("limits must include a 'free' fallback.", 400);
    }

    // Zero means the feature isn't on this tier at all — a different
    // message from "you've used them all", and the frontend words it so.
    if (limit === 0) {
      return res.status(402).json({
        success: false,
        // A vendor is never told to buy a buyer subscription — same rule as
        // the search quota's own wording.
        message:
          ownerType === "vendor"
            ? "Price watches aren't available on your account yet."
            : "Price watches are a Velte Plus feature.",
        code: "plan_required",
      });
    }

    const active = await PriceWatch.countDocuments({
      ownerId,
      ownerType,
      status: "active",
    });
    if (active >= limit) {
      return res.status(402).json({
        success: false,
        message: `You're watching ${limit} items already. Remove one to add another.`,
        code: "limit_reached",
      });
    }

    // Upsert rather than insert: re-watching something already watched
    // should be a no-op that returns the existing watch, not a duplicate-key
    // error the buyer has to interpret. The partial unique indexes make the
    // filter exact for each kind.
    const filter =
      kind === "velte"
        ? { ownerId, ownerType, productId }
        : { ownerId, ownerType, url };

    const watch = await PriceWatch.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          ownerId,
          ownerType,
          kind,
          productId: kind === "velte" ? productId : null,
          url: kind === "external" ? url : null,
          startPriceKobo: priceKobo,
          lastPriceKobo: priceKobo,
        },
        $set: {
          label: label.slice(0, 200),
          imageUrl: imageUrl ?? null,
          merchant: merchant ?? null,
          targetPriceKobo: Number.isInteger(targetPriceKobo)
            ? targetPriceKobo
            : null,
          // Re-watching something previously removed revives it.
          status: "active",
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();

    return res.status(201).json({ success: true, data: { watch } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/price-watch ─────────────────────────────────────────────────
export async function listWatches(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const watches = await PriceWatch.find({
      ownerId: req.actor.id,
      ownerType: req.actor.type,
      status: { $ne: "ended" },
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return res.json({ success: true, data: { watches } });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/price-watch/:id ──────────────────────────────────────────
export async function removeWatch(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const result = await PriceWatch.deleteOne({
      _id: req.params.id,
      // Scoped to the owner — an id alone must never be enough to delete
      // someone else's watch, and a buyer id must never match a vendor's.
      ownerId: req.actor.id,
      ownerType: req.actor.type,
    });
    if (!result.deletedCount) throw new AppError("Watch not found.", 404);
    return res.json({ success: true, message: "Watch removed." });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The checker's two endpoints. Called by Velte's own frontend cron route,
// never by a browser — see routes/priceWatch.routes.js for the shared-secret
// guard and why the work is split across repos this way.
// ─────────────────────────────────────────────────────────────────────────

// ── GET /api/price-watch/due ─────────────────────────────────────────────
//
// Watches needing a re-check, oldest first. `limit` is small by default: the
// caller re-fetches a page per external watch, and a cron tick that tries to
// do everything at once is one that times out and does nothing.
export async function listDue(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const staleBefore = new Date(Date.now() - STALE_MS);

    const watches = await PriceWatch.find({
      status: "active",
      // EXTERNAL only. A Velte product's price is a column in this repo's
      // own database, so it is checked here by jobs/priceWatch.job.js
      // without any HTTP at all — handing it to the frontend checker would
      // be a round trip to learn something we already know.
      kind: "external",
      // Never checked, or not checked within STALE_MS.
      $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: staleBefore } }],
      failureCount: { $lt: 5 },
    })
      .sort({ lastCheckedAt: 1 })
      .limit(limit)
      .select("kind productId url label lastPriceKobo targetPriceKobo")
      .lean();

    return res.json({ success: true, data: { watches } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/price-watch/report ─────────────────────────────────────────
//
// Body: { results: [{ id, priceKobo? , failed? }] }
//
// The caller re-priced the watches it was given; this decides what that
// means, records it, and sends any alerts. Deciding lives HERE rather than
// in the caller so the notification rules stay next to the data they act on.
export async function reportChecks(req, res, next) {
  try {
    const { results } = req.body ?? {};
    if (!Array.isArray(results)) {
      throw new AppError("results must be an array.", 400);
    }

    // Paces repeat alerts on the same watch — see COOLDOWN_MS.
    const cooldown = new Date(Date.now() - COOLDOWN_MS);
    let notified = 0;
    let dropped = 0;

    for (const result of results.slice(0, 200)) {
      const watch = await PriceWatch.findById(result?.id).catch(() => null);
      if (!watch || watch.status !== "active") continue;

      if (result.failed || !Number.isInteger(result.priceKobo)) {
        // A page that can't be read is a soft failure — counted, not fatal.
        // Five in a row and it stops being checked (see listDue's filter):
        // a delisted product shouldn't be fetched forever.
        watch.failureCount += 1;
        watch.lastCheckedAt = new Date();
        await watch.save();
        continue;
      }

      const previous = watch.lastPriceKobo;
      const current = result.priceKobo;

      watch.failureCount = 0;
      watch.lastCheckedAt = new Date();
      watch.lastPriceKobo = current;

      // Two ways to qualify: below the buyer's own target if they set one,
      // otherwise any real drop against the last price we saw.
      const hitTarget =
        watch.targetPriceKobo != null && current <= watch.targetPriceKobo;
      const justCheaper = watch.targetPriceKobo == null && current < previous;
      const isDrop = hitTarget || justCheaper;

      const outOfCooldown =
        !watch.lastNotifiedAt || watch.lastNotifiedAt <= cooldown;

      if (isDrop) dropped += 1;

      if (isDrop && outOfCooldown) {
        const owner = await findWatchOwner(watch.ownerId, watch.ownerType);

        // Email and SMS, both best-effort — see helpers/priceDropAlert.js.
        // Only stamped on an actual send, so a total notification outage
        // retries next sweep instead of silencing the alert for a day.
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
    }

    if (results.length) {
      console.log(
        `[price-watch] checked ${results.length}, ${dropped} dropped, ${notified} alerted`,
      );
    }
    return res.json({
      success: true,
      data: { checked: results.length, dropped, notified },
    });
  } catch (err) {
    next(err);
  }
}
