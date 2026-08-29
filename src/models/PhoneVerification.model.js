import mongoose from "mongoose";

// A phone number being verified, for someone who is NOT signed in
// (2026-08-27).
//
// This exists because of an explicit product decision: a phone + OTP round
// must not create an account. `buyer_auth_token` — and therefore a Buyer
// document — now means one thing only, "signed in with Google". Verifying a
// number proves you own it for the length of one Buyer Request; it does not
// make you a user of anything.
//
// Before this, the Buyer document itself held the OTP, which is what made
// every phone verification quietly mint an account. That's the whole reason
// the buyers collection had a phone-only record in it.
//
// A signed-in buyer does NOT come through here: their code lives on their
// own Buyer document (`pendingPhone` + `phoneOtp`), because for them the
// point of verifying IS to attach the number to their account.
const phoneVerificationSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    code: {
      type: Number,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

// Mongo deletes each document the moment `expiresAt` passes, so an
// unfinished verification cleans itself up rather than accumulating
// forever. `expireAfterSeconds: 0` means "expire AT the date in this field",
// not "zero seconds from now" — the TTL monitor runs about once a minute, so
// treat removal as prompt but not instant. The controller checks `expiresAt`
// itself regardless and never relies on the sweep for correctness.
phoneVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("PhoneVerification", phoneVerificationSchema);
