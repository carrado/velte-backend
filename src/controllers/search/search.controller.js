import crypto from "crypto";
import { AppError } from "../../middleware/errorHandler.js";
import Product from "../../models/Product.model.js";
import Store from "../../models/Store.model.js";
import LeadCooldown from "../../models/LeadCooldown.model.js";
import BuyerRequest from "../../models/BuyerRequest.model.js";
import { debitWalletForLead } from "../wallet/wallet.controller.js";
import { notifyUser } from "../../services/pushNotification.service.js";

// searchProducts/searchStores/logSearch (the buyer-facing search hot path)
// moved to the standalone staffly-ai-backend service — see its README. This
// file keeps only chargeLead: the frontend's sendBeacon call hits this
// endpoint directly, never through the search service, so no cross-service
// call was needed to keep wallet-mutation logic sole-owned here.

// Atomic check-and-start: findOneAndUpdate with upsert + $setOnInsert means
// a fresh (vendorId, buyerId) pair inserts a new cooldown doc AND returns
// null (the pre-update state, since `new: false`) — that null is the "go
// ahead and charge" signal. An existing doc (still within its TTL window)
// returns non-null and its own createdAt is left untouched, so repeat
// clicks during the window never push the expiry back out. Falls open
// (never blocks a charge) on any unexpected error or on a missing buyerId —
// dedup is a cost-saving nicety for the vendor, not something a bug in it
// should ever be able to turn into "buyer clicked, vendor was never told."
async function isWithinCooldown(vendorId, buyerId) {
  if (typeof buyerId !== "string" || !buyerId.trim()) return false;
  try {
    const existing = await LeadCooldown.findOneAndUpdate(
      { vendorId, buyerId },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true, new: false },
    );
    return existing !== null;
  } catch (err) {
    // A concurrent request for the same pair won the insert race first —
    // that's still "within cooldown" from this request's point of view.
    if (err.code === 11000) return true;
    console.error("[chargeLead] cooldown check failed:", err.message);
    return false;
  }
}

// ── POST /api/search/lead ──────────────────────────────────────────────────────
// Public — "a buyer is about to chat this vendor": debits the vendor's wallet
// for the lead AND returns the number to send them to.
//
// 2026-08-27: it used to be fired-and-forgotten from the browser via
// sendBeacon, AFTER the chat had already opened client-side from a wa.me link
// the page had built itself. Two problems with that, both fixed by returning
// the number here: the vendor's number had to be in the page to build that
// link (readable from a hover, or from "copy link address"), and the beacon
// was silently dropped by ad-blockers — its own comment below admits a real
// lead then went unbilled with zero visibility. Now the frontend's /api/chat
// route calls this server-side and redirects, so billing happens on the
// journey itself rather than on a beacon that may never leave.
//
// Still never fails the buyer's chat: an insufficient balance, a failed
// notification or a missing store all still return a usable response. Insufficient balance just means this lead goes
// unbilled (see debitWalletForLead's `debited: false` — today that's a no-op,
// eligibility policy for a drained wallet is a matching-layer decision, not
// this endpoint's).
const LEAD_SOURCES = ["browse", "search", "buyer_request"];

export async function chargeLead(req, res, next) {
  try {
    const { vendorId, productId, buyerId, source, requestId } = req.body ?? {};
    if (typeof vendorId !== "string" || !vendorId.trim()) {
      throw new AppError("vendorId is required.", 400);
    }
    // An unrecognized/missing source is never worth rejecting the whole
    // request over — the buyer's chat has already opened by the time this
    // fires (see this endpoint's own doc comment) — just don't tag it.
    const leadSource = LEAD_SOURCES.includes(source) ? source : null;

    // The buyer contacting ANY vendor from a request closes it (2026-09-14).
    // Before this, chargeLead only ever touched the wallet ledger — the
    // BuyerRequest itself was never told, so it sat "active" for the full
    // 48h regardless: other vendors kept quoting, the reminder sweep kept
    // nudging non-responders, and the buyer notification sweep kept firing,
    // all for a request the buyer had already acted on. `"fulfilled"` has
    // existed in the model's own status enum since the schema was written;
    // this is the first place anything actually sets it.
    //
    // Fire-and-forget, matching every other best-effort side-effect on this
    // hot path (see notifyUser below) — closing the request is not part of
    // what the buyer's chat is waiting on. `status: "active"` in the filter
    // makes this a no-op on an already-fulfilled/expired/cancelled request,
    // so a repeat click (this buyer messaging a SECOND vendor from the same
    // request, or reopening the same conversation later) never reopens or
    // errors on one already closed — and the buyer keeps being able to
    // message other responders from their own Requests page regardless;
    // only the BACKGROUND soliciting (reminders, new-response notices, the
    // vendor's own "still open" list) stops.
    if (
      leadSource === "buyer_request" &&
      typeof requestId === "string" &&
      requestId
    ) {
      BuyerRequest.updateOne(
        { _id: requestId, status: "active" },
        { $set: { status: "fulfilled" } },
      ).catch((err) => {
        console.error(
          `[chargeLead] failed to close request ${requestId}:`,
          err.message,
        );
      });
    }

    // NOTE on buyerId semantics for a "buyer_request"-sourced lead: for
    // "browse"/"search" this has always been an anonymous, per-browser
    // string used only for the cooldown dedup below (see LeadCooldown's own
    // doc comment) — never a real account. For "buyer_request" it's the
    // authenticated Buyer's real _id (the frontend has one, since posting a
    // request required verifying). It still works here mechanically — this
    // field is a bare String in LeadCooldown — but it's worth knowing the
    // meaning shifts per source rather than assuming it's always opaque.

    // Same buyer, same vendor, within 15 minutes of their last charged
    // click — skip billing entirely rather than charge again for what's
    // very likely still the same visit (see LeadCooldown's own doc
    // comment). A different buyer, or the same buyer past the window,
    // charges exactly as normal.
    // Resolved up front because BOTH exits below need it (2026-08-27): this
    // endpoint now also tells the caller WHERE to send the buyer, so the
    // vendor's number never has to reach the browser to build a wa.me link.
    // See the frontend's /api/chat route — it calls this, then redirects.
    //
    // A cooled-down click still gets the number: the buyer is chatting
    // either way, and the cooldown decides whether to BILL, not whether to
    // connect them. Withholding it there would break the second click in a
    // 15-minute window for no reason.
    const store = await Store.findOne({ vendorId }).select("whatsapp").lean();
    const whatsapp = store?.whatsapp ?? null;

    if (await isWithinCooldown(vendorId, buyerId)) {
      return res.json({ success: true, data: { billed: false, whatsapp } });
    }

    // A buyer-request lead is charged ONCE per (request, vendor), for good —
    // not once per click, and not once per 15-minute cooldown window. The
    // buyer can come back to their requests page next week and message the
    // same business again; that is the same lead, already paid for.
    //
    // So the key is derived rather than minted, and `reference`'s unique
    // index does the enforcing (see debitWalletForLead, which now unwinds a
    // duplicate instead of throwing on one). The 15-minute LeadCooldown above
    // still applies and is still useful for browse/search leads, but it is no
    // longer what protects this path.
    //
    // The format deliberately MATCHES the one decideOnRequest used while the
    // charge still happened at accept time. Every vendor already billed under
    // that flow therefore has a ledger row whose reference this collides with
    // — so when the buyer finally messages them, they are not charged a second
    // time for a lead they already paid for. The migration needs no backfill.
    const leadId =
      leadSource === "buyer_request" && typeof requestId === "string" && requestId
        ? `buyer_request_${requestId}_${vendorId}`
        : `lead_${vendorId}_${Date.now()}_${crypto
            .randomBytes(4)
            .toString("hex")}`;

    // Best-effort: the wallet ledger should read like "WhatsApp lead —
    // white sneakers", never a raw ObjectId — if the lookup fails (bad id,
    // product since deleted), fall back to the generic description rather
    // than let a Mongo _id leak into the vendor-facing Spend History table.
    let productName = null;
    let description = "WhatsApp lead";
    if (typeof productId === "string" && productId) {
      try {
        const product = await Product.findById(productId).select("name");
        if (product?.name) {
          productName = product.name;
          description = `WhatsApp lead — ${product.name}`;
        }
      } catch {
        // keep the generic description
      }
    }

    const result = await debitWalletForLead(vendorId, {
      leadId,
      description,
      source: leadSource,
      requestId: leadSource === "buyer_request" && typeof requestId === "string" ? requestId : null,
    });

    // Best-effort, same as the wallet-low-balance and referral notifiers —
    // the buyer's chat has already opened client-side by now, so a failure
    // here must never surface as an error to them.
    //
    // Still fires when the lead went UNBILLED for want of balance: a drained
    // wallet is the vendor's problem to fix, and the lead is real either way.
    // It does NOT fire for `already_charged`, which is a different thing
    // entirely — the same buyer reopening the same conversation, about a lead
    // this vendor was already told about and already paid for. That is the
    // one case where the click is not news.
    if (result.reason !== "already_charged") {
      notifyUser(vendorId, {
        type: "new-lead",
        title: "New WhatsApp lead",
        body: productName
          ? `A buyer wants to chat about ${productName}.`
          : "A buyer clicked through to chat on WhatsApp.",
        url: `/${vendorId}/wallet`,
        tag: "new-lead",
      }).catch((err) => {
        console.error(
          `[chargeLead] notify failed for ${vendorId}:`,
          err.message,
        );
      });
    }

    res.json({ success: true, data: { billed: result.debited, whatsapp } });
  } catch (err) {
    next(err);
  }
}
