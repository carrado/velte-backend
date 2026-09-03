import Wallet from "../models/Wallet.model.js";
import { notifyUser } from "../services/pushNotification.service.js";
import { sendSms } from "../services/sendchamp.service.js";
import { leadsRemaining, MIN_LEAD_COST_KOBO } from "../utils/leadPricing.js";

// ₦2,000 — twice MIN_LEAD_COST_KOBO (₦1,000, the flat per-lead rate — see
// utils/leadPricing.js) so a vendor gets warned with room to top up before
// search-eligibility (which gates on the SAME MIN_LEAD_COST_KOBO floor)
// actually cuts them off. The 2x buffer is the point: leaving this at
// ₦1,000 would have meant the warning fired at the EXACT moment a
// vendor could no longer afford a lead, with zero room to react. This is a
// separate, wider-buffer signal from the narrower "covers at most 1 lead"
// SMS trigger below (canOnlyAffordUpToOneLead) — this one still only ever
// drives the in-app push. "For now" per the user — expect this to move.
export const LOW_BALANCE_KOBO = 200_000;

// How often a vendor still under threshold gets reminded if they never
// topped up — the FIRST notification for a low episode always fires
// immediately (see the query below); this only paces the repeats. Shared
// by both the push and SMS channels below for simplicity; nothing stops
// these from diverging later if SMS's real per-send cost argues for a
// longer interval than push's.
//
// null = repeats OFF (2026-08-27, "for now" per explicit request): a vendor
// hears about a low balance exactly ONCE per episode and not again until
// the balance climbs back above the threshold and dips a second time — the
// recovery passes at the bottom clear the timestamps, and that clearing is
// what starts a fresh episode. Both channels honour it; put a duration back
// here (it was 24 * 60 * 60 * 1000) and the old cadence returns with no
// other edit, since every read below already handles either mode.
const REMINDER_INTERVAL_MS = null;

// A cheap Mongo-side prefilter for the SMS check below;
// leadsRemaining/canOnlyAffordUpToOneLead is still what actually decides.
// Twice the per-lead rate is always enough headroom: covering a second lead
// never needs more than 2 × MIN_LEAD_COST_KOBO, so anything at or above that
// can afford at least 2 leads and is never worth fetching for this check.
// (This was load-bearing while pricing was tiered and the real test could not
// be expressed as a single balance comparison. Flat pricing makes the two
// agree exactly, but the prefilter is still the cheaper query.)
const SMS_QUERY_CEILING_KOBO = MIN_LEAD_COST_KOBO * 2;

// Per explicit request: the trigger for the low-wallet SMS (see below) is
// "the balance can cover at most ONE more lead" — narrower and more urgent
// than the general LOW_BALANCE_KOBO push threshold above. Delegates to
// leadsRemaining (utils/leadPricing.js) rather than a flat number so this
// stays correct if the per-lead rate, or LOW_BALANCE_KOBO, ever change
// independently — even though today's specific numbers happen to make
// this trigger at the same balance as the push.
function canOnlyAffordUpToOneLead(balanceKobo) {
  return leadsRemaining(balanceKobo, 2) <= 1;
}

/**
 * Scans every active wallet for a low balance and notifies the vendor — a
 * periodic sweep rather than an on-debit check, so a vendor still gets
 * warned even if nothing happens to charge their wallet for a while (an
 * on-debit trigger only ever fires when a NEW lead lands, which says
 * nothing about balances that are already low and just sitting there).
 * Notifies once per low episode while REMINDER_INTERVAL_MS is null (the
 * current setting — see the constant); with an interval set it re-reminds
 * on that cadence for as long as the balance stays low.
 *
 * Two independent channels, one sweep: the existing in-app push (unchanged
 * threshold/behavior), plus an SMS — per explicit request, this does NOT
 * replace the push, it's additive, specifically because many vendors never
 * install the PWA and would otherwise never see a push notification at
 * all. The SMS fires on its own, narrower trigger (canOnlyAffordUpToOneLead)
 * and its own episode timestamp (lowWalletSmsLastSentAt), so the two can
 * genuinely diverge — a vendor could get the push (balance < ₦2,000) well
 * before ever qualifying for the SMS (covers ≤ 1 lead).
 */
export async function checkLowWalletBalances() {
  const reminderCutoff =
    REMINDER_INTERVAL_MS === null
      ? null
      : new Date(Date.now() - REMINDER_INTERVAL_MS);

  // Never notified this episode -> always due. Already notified -> due only
  // if repeats are switched on AND the interval has elapsed.
  const dueForNotice = (lastSentAt) =>
    !lastSentAt || (reminderCutoff !== null && lastSentAt <= reminderCutoff);
  const queryCeiling = Math.max(LOW_BALANCE_KOBO, SMS_QUERY_CEILING_KOBO);

  // One query covers both channels' candidates — anything below either
  // threshold could need push, SMS, or both; the per-wallet checks below
  // decide which. `phone`/`name` are only ever needed for the SMS, but
  // populating them here is cheap and keeps this to one round trip instead
  // of a second lookup per SMS-eligible wallet.
  const candidates = await Wallet.find({
    status: "active",
    balanceKobo: { $lt: queryCeiling },
  })
    .select(
      "vendorId balanceKobo lowBalanceLastNotifiedAt lowWalletSmsLastSentAt",
    )
    .populate("vendorId", "phone name");

  let pushSent = 0;
  let smsSent = 0;

  for (const wallet of candidates) {
    const vendor = wallet.vendorId; // populated {_id, phone, name}
    const vendorId = vendor?._id ?? wallet.vendorId;
    let changed = false;

    const needsPush =
      wallet.balanceKobo < LOW_BALANCE_KOBO &&
      dueForNotice(wallet.lowBalanceLastNotifiedAt);
    if (needsPush) {
      try {
        await notifyUser(vendorId, {
          type: "wallet",
          title: "Wallet balance running low",
          body: `Your Velte wallet balance is ₦${(wallet.balanceKobo / 100).toLocaleString("en-NG")} — top up to keep showing up in buyer searches.`,
          url: `/${vendorId}/wallet`,
          tag: "wallet-low-balance",
        });
        wallet.lowBalanceLastNotifiedAt = new Date();
        changed = true;
        pushSent += 1;
      } catch (err) {
        console.error(
          `[wallet-cron] low-balance push failed for ${vendorId}:`,
          err.message,
        );
      }
    }

    const needsSms =
      canOnlyAffordUpToOneLead(wallet.balanceKobo) &&
      dueForNotice(wallet.lowWalletSmsLastSentAt);
    if (needsSms) {
      if (vendor?.phone) {
        try {
          const name = vendor.name ? `Hi ${vendor.name}, ` : "";
          await sendSms(
            vendor.phone,
            `${name}this is Velte. Your wallet balance (₦${(wallet.balanceKobo / 100).toLocaleString("en-NG")}) can only cover one more lead, or none at all. Top up now to keep showing up in buyer searches: velte.ng/${vendorId}/wallet`,
          );
          smsSent += 1;
        } catch (err) {
          console.error(
            `[wallet-cron] low-wallet SMS failed for ${vendorId}:`,
            err.message,
          );
        }
      }
      // Marks the episode either way, even on a send failure/missing
      // phone — same "don't retry every single tick" reasoning as the
      // push side; a vendor with no phone on file still gets the push
      // above regardless, so this never leaves them with zero warning.
      wallet.lowWalletSmsLastSentAt = new Date();
      changed = true;
    }

    if (changed) await wallet.save();
  }

  // Recovered wallets, push side: same "clear the flag" as before — a
  // balance back at or above LOW_BALANCE_KOBO starts a fresh episode next
  // time it dips, rather than inheriting the old reminder cadence.
  const { modifiedCount: pushRecovered } = await Wallet.updateMany(
    {
      balanceKobo: { $gte: LOW_BALANCE_KOBO },
      lowBalanceLastNotifiedAt: { $ne: null },
    },
    { $set: { lowBalanceLastNotifiedAt: null } },
  );

  // Recovered wallets, SMS side — can't reuse the query above: "can only
  // afford ≤1 lead" is tiered, not a single flat balance comparison, so a
  // plain $gte filter can't express it. The flagged set is always small
  // (only ever wallets that already triggered the SMS at least once), so
  // a fetch-then-filter-in-JS pass here is cheap.
  const smsFlagged = await Wallet.find({
    lowWalletSmsLastSentAt: { $ne: null },
  }).select("balanceKobo lowWalletSmsLastSentAt");
  const recoveredSmsIds = smsFlagged
    .filter((w) => !canOnlyAffordUpToOneLead(w.balanceKobo))
    .map((w) => w._id);
  let smsRecovered = 0;
  if (recoveredSmsIds.length) {
    ({ modifiedCount: smsRecovered } = await Wallet.updateMany(
      { _id: { $in: recoveredSmsIds } },
      { $set: { lowWalletSmsLastSentAt: null } },
    ));
  }

  if (pushSent || smsSent || pushRecovered || smsRecovered) {
    console.log(
      `[wallet-cron] push: ${pushSent} sent, ${pushRecovered} recovered. SMS: ${smsSent} sent, ${smsRecovered} recovered.`,
    );
  }
}
