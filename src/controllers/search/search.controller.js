import crypto from "crypto";
import { AppError } from "../../middleware/errorHandler.js";
import Product from "../../models/Product.model.js";
import LeadCooldown from "../../models/LeadCooldown.model.js";
import { debitWalletForLead, LEAD_COST_KOBO } from "../wallet/wallet.controller.js";
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
// Public — fired the instant a buyer clicks "Chat on WhatsApp" on a vendor or
// product card (frontend uses navigator.sendBeacon so it survives the
// immediate tab switch to WhatsApp). Debits the vendor's wallet for the lead;
// never blocks or fails the buyer's chat, which has already opened client-side
// by the time this resolves. Insufficient balance just means this lead goes
// unbilled (see debitWalletForLead's `debited: false` — today that's a no-op,
// eligibility policy for a drained wallet is a matching-layer decision, not
// this endpoint's).
export async function chargeLead(req, res, next) {
  try {
    const { vendorId, productId, buyerId } = req.body ?? {};
    if (typeof vendorId !== "string" || !vendorId.trim()) {
      throw new AppError("vendorId is required.", 400);
    }

    // Same buyer, same vendor, within 15 minutes of their last charged
    // click — skip billing entirely rather than charge again for what's
    // very likely still the same visit (see LeadCooldown's own doc
    // comment). A different buyer, or the same buyer past the window,
    // charges exactly as normal.
    if (await isWithinCooldown(vendorId, buyerId)) {
      return res.json({ success: true, data: { billed: false } });
    }

    const leadId = `lead_${vendorId}_${Date.now()}_${crypto
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

    const result = await debitWalletForLead(vendorId, LEAD_COST_KOBO, {
      leadId,
      description,
    });

    // Best-effort, same as the wallet-low-balance and referral notifiers —
    // the buyer's chat has already opened client-side by now, so a failure
    // here must never surface as an error to them. Fires regardless of
    // `billed`: an unbilled lead (drained wallet) is still a real lead the
    // vendor should know about.
    notifyUser(vendorId, {
      type: "new-lead",
      title: "New WhatsApp lead",
      body: productName
        ? `A buyer wants to chat about ${productName}.`
        : "A buyer clicked through to chat on WhatsApp.",
      url: `/${vendorId}/wallet`,
      tag: "new-lead",
    }).catch((err) => {
      console.error(`[chargeLead] notify failed for ${vendorId}:`, err.message);
    });

    res.json({ success: true, data: { billed: result.debited } });
  } catch (err) {
    next(err);
  }
}
