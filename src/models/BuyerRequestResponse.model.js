import mongoose from "mongoose";

// 2026-08-18 — repurposed from a free-text "vendor typed a reply" record
// into a simple accept/decline decision. There's no buyer inbox left to
// read a typed response in anymore (buyers have no account), so the old
// "vendor writes a message, buyer reads it later and picks who to chat"
// flow is gone. Now: a vendor either Accepts (pays for the lead, gets the
// buyer's WhatsApp number right there) or Declines (free, no contact info)
// — see vendorBuyerRequests.controller.js's decideOnRequest.
const buyerRequestResponseSchema = new mongoose.Schema(
  {
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BuyerRequest",
      required: true,
      index: true,
    },
    // Copied from the request, and NULL whenever that request was made by
    // someone with no account (2026-08-27) — which is now the common case,
    // since verifying a phone stopped creating a Buyer. Was `required: true`,
    // which would have thrown at the worst possible moment: a vendor
    // ACCEPTING an anonymous buyer's request, the exact step that releases
    // the WhatsApp number and makes the whole flow pay off.
    //
    // Nothing here needs it — the vendor reads the buyer's name and number
    // off the request's own snapshot, never through this ref.
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      default: null,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    decision: {
      type: String,
      enum: ["accepted", "declined"],
      required: true,
    },

    // ── The QUOTE (2026-09-03) ────────────────────────────────────────────
    //
    // What turns this row from a yes/no into an answer. Before this, a vendor
    // could say "I can supply that" but not "for ₦450,000, in 2 days" — so a
    // buyer with three acceptances had three names and no way to choose
    // between them, and the whole point of broadcasting a request to several
    // vendors was lost at the last step.
    //
    // ALL THREE ARE OPTIONAL, deliberately, and only meaningful on an
    // "accepted" row. Requiring a price would change what Accept means for
    // every vendor already using it — some legitimately want to talk before
    // committing to a number, and a vendor forced to type one will type a
    // placeholder, which is worse than no quote at all. The comparison
    // (lib/quoteCompare.ts) simply ranks whoever quoted and lists the rest.
    //
    // VENDOR-STATED, not verified. This is the vendor's own claim about their
    // own price, which is exactly the kind of number Velte does not invent
    // and does not check — the buyer is told who said it and when, and the
    // comparison never blends a quote with a market figure.

    /** Kobo, like every other money field here. Null when the vendor accepted
     *  without naming a price. */
    priceKobo: { type: Number, default: null, min: 0 },

    /** How soon they can supply it, in days. 0 means "available now", which
     *  is why the field is nullable rather than defaulting to 0 — "today" and
     *  "didn't say" must not read as the same answer. */
    leadTimeDays: { type: Number, default: null, min: 0 },

    /** Anything the price alone doesn't carry: warranty, free delivery,
     *  condition, "price is for 20 units". Short on purpose — this is a line
     *  on a comparison row, not a message thread. */
    note: { type: String, default: null, trim: true, maxlength: 200 },

    /** When the BUYER messaged THIS vendor from their requests page
     *  (2026-09-24) — set by chargeLead on the first click, never cleared.
     *  The only per-vendor record of who got picked: the request's own
     *  `fulfilled` status says the buyer contacted SOMEONE, and the wallet
     *  ledger can't stand in (no row on a cooled-down click, and pre-
     *  2026-09-03 accept-time charges share the same reference). Drives the
     *  vendor's "Won" history. Null for everything contacted before this
     *  field existed — that history simply wasn't recorded. */
    contactedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One decision per vendor per request — a duplicate insert attempt hits
// this and surfaces as a clean 409 via the existing global errorHandler's
// 11000 branch, no extra controller code needed. This is also the real
// guard against a double-charge race in decideOnRequest: the response doc
// is created (and must win this unique index) BEFORE the wallet is ever
// debited, so two concurrent Accepts can never both charge.
buyerRequestResponseSchema.index(
  { requestId: 1, vendorId: 1 },
  { unique: true },
);

export default mongoose.model(
  "BuyerRequestResponse",
  buyerRequestResponseSchema,
);
