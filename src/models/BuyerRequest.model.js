import mongoose from "mongoose";

// Default request lifetime — per docs/velte_buyer_requests_mvp_spec.md §11.
// A named constant, not a magic 48 sprinkled across files (the spec's own
// instruction), consumed by both request creation and the expiry cron.
export const BUYER_REQUEST_EXPIRY_HOURS = 48;

const buyerRequestSchema = new mongoose.Schema(
  {
    // NULL for a request made by someone with no account (2026-08-27).
    // Verifying a phone stopped creating a Buyer — `buyer_auth_token` now
    // means "signed in with Google" and nothing else — so most requests
    // legitimately have no buyer behind them. The request stands on its own
    // snapshot instead, which is where a buyer's details already lived.
    // Still set, and still indexed, when a signed-in buyer makes one.
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      default: null,
      index: true,
    },
    // Snapshotted straight onto the request at creation time (2026-08-18),
    // not read live off the Buyer doc — Buyer.model.js no longer carries a
    // name at all (buyers stay anonymous otherwise; see its own comment),
    // so this is the ONLY place a buyer's name ever lives, scoped to this
    // one request. The AI collects it conversationally before calling
    // createBuyerRequest (see createBuyerRequestTool.ts / systemPrompt.ts).
    buyerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    // Also snapshotted rather than populated via buyerId — this is the
    // number a vendor WhatsApps directly once they Accept (see
    // vendorBuyerRequests.controller.js's decideOnRequest). Never sent to
    // the client until that vendor has actually accepted and paid for the
    // lead — see getRequestDetail/listMatchedRequests, which strip it out
    // until then.
    buyerPhone: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    // What the buyer said they are willing to spend, in kobo (2026-09-03).
    //
    // ITS OWN FIELD, not a phrase inside `description`. It was always allowed
    // to appear in the description — buildRequestDescription is told to fold
    // in a budget if one was mentioned — but a number buried in prose is one
    // a vendor may never read, and this is the number they most need before
    // deciding whether to answer at all: a lead costs them ₦1,000, and
    // "twenty office chairs" tells them nothing about whether their price is
    // anywhere near this buyer's.
    //
    // NULLABLE, and that is deliberate. A buyer who genuinely has no figure
    // in mind should not be blocked from asking, and every request created
    // before this shipped has none. Vendors see "no budget given" rather than
    // a fabricated one.
    budgetKobo: {
      type: Number,
      default: null,
      min: 0,
    },
    // Frontend uploads directly to Cloudinary and sends only the resulting
    // URL — no backend upload endpoint exists or is needed.
    imageUrl: {
      type: String,
      default: null,
    },
    // Same GeoJSON Point shape as User.geo, for consistency with the
    // matching service's existing distance calculations. Only ever set from
    // the buyer's own device location, granted for THIS request — no
    // fallback to any saved/remembered location (there isn't one to fall
    // back to; buyers don't have accounts). Absent entirely means the buyer
    // didn't grant location this time — the vendor-facing detail page shows
    // "N/A" rather than guessing.
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },

    status: {
      type: String,
      enum: ["active", "fulfilled", "expired", "cancelled"],
      default: "active",
      index: true,
    },

    // Populated once at creation from the staffly-ai-backend matching call
    // (see services/matchingClient.service.js) — NOT re-run on every read.
    // Retroactive matching (a new/edited vendor matching an existing active
    // request later) is a documented V2 follow-up, not built here.
    matchedVendorIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },

    responseCount: { type: Number, default: 0, min: 0 },

    // Accepts ONLY (2026-09-03). `responseCount` counts declines too, and a
    // decline is not news: it releases nothing, costs the vendor nothing, and
    // is never shown to the buyer (see listMyRequests, which lists accepted
    // responders only). Notifying on it would send "someone responded" to a
    // buyer who then opens Velte and finds nothing — the worst possible
    // notification, and exactly what the restored sweep would have sent if it
    // kept watching `responseCount` the way the deleted one did.
    acceptedCount: { type: Number, default: 0, min: 0 },

    lastResponseAt: { type: Date, default: null },

    // ── Buyer notification watermark (restored 2026-09-03) ────────────────
    //
    // These were dropped on 2026-08-18 along with the sweep that used them,
    // on the stated grounds that "buyers have no account/inbox to notify
    // into anymore". Buyers have had accounts since 2026-08-26, and posting
    // a request has REQUIRED one since 2026-08-29 — so that reasoning is
    // obsolete and its consequence was not: a buyer posted a request and was
    // never told when someone answered it. Asynchronous by nature, with no
    // return path.
    //
    // Advanced only on a CONFIRMED send (jobs/buyerRequestNotifications),
    // so a failed email/SMS retries on the next sweep rather than being
    // silently swallowed.
    lastBuyerNotifiedAcceptedCount: { type: Number, default: 0, min: 0 },
    lastBuyerNotificationAt: { type: Date, default: null },

    expiresAt: {
      type: Date,
      required: true,
      default: () =>
        new Date(Date.now() + BUYER_REQUEST_EXPIRY_HOURS * 60 * 60 * 1000),
      index: true,
    },

    // Set once, at the halfway point of THIS request's own window (see
    // jobs/buyerRequestVendorReminder.job.js) — a vendor who was matched but
    // has neither accepted nor declined gets exactly one nudge, never a
    // repeat. Computed from createdAt/expiresAt rather than a hardcoded
    // hour count, same reasoning as RequestsPage.tsx's own elapsed-window
    // bar: changing BUYER_REQUEST_EXPIRY_HOURS must not quietly change what
    // "halfway" means for a request already in flight.
    //
    // Best-effort, not a delivery watermark like lastBuyerNotifiedAt above —
    // this fires alongside the same best-effort push notifyUser already
    // sends on request creation, not the confirmed-delivery SMS/email path.
    // Set regardless of individual push outcomes so one dead subscription
    // can't leave a request re-scanned by every sweep forever.
    reminderSentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

buyerRequestSchema.index({ location: "2dsphere" });
buyerRequestSchema.index({ buyerId: 1, status: 1, createdAt: -1 });
buyerRequestSchema.index({ matchedVendorIds: 1, status: 1 });

export default mongoose.model("BuyerRequest", buyerRequestSchema);
