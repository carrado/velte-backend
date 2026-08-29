import jwt from "jsonwebtoken";

import Buyer from "../models/Buyer.model.js";
import User from "../models/Users.js";

// Resolves whoever is making the request, whichever kind of account they
// have (2026-08-29).
//
// Velte deliberately runs two independent sessions in the same browser — a
// vendor's `auth_token` and a buyer's `buyer_auth_token` — so that a vendor
// can browse /chat without clobbering their dashboard session. Every guard
// before this one picked exactly one of those, which is right for a
// dashboard route or a buyer-request route. Metering is the first thing that
// legitimately applies to BOTH, so it gets a guard that accepts either.
//
// Sets `req.actor = { id, type }`. Buyer wins when both cookies are present:
// someone on /chat with both sessions is acting as a buyer there, and their
// buyer account is the one carrying a plan.
//
// Never 401s. An unauthenticated caller gets `req.actor = null` and the
// route decides — for metering, that is a guest, which is a real state with
// its own allowance rather than an error.
export const resolveActor = async (req, _res, next) => {
  req.actor = null;

  const buyerToken = req.cookies?.buyer_auth_token;
  if (buyerToken) {
    try {
      const decoded = jwt.verify(buyerToken, process.env.JWT_SECRET);
      if (decoded.type === "buyer" && decoded.buyerId) {
        // Confirmed against the collection, not just the signature — a token
        // for a deleted account must not create usage rows for an owner that
        // no longer exists.
        const buyer = await Buyer.findById(decoded.buyerId)
          .select("_id")
          .lean();
        if (buyer) {
          req.actor = { id: decoded.buyerId, type: "buyer" };
          return next();
        }
      }
    } catch {
      // Expired or forged — fall through and try the vendor cookie rather
      // than failing outright. A vendor with a stale buyer token should
      // still be recognised as a vendor.
    }
  }

  const vendorToken = req.cookies?.auth_token;
  if (vendorToken) {
    try {
      const decoded = jwt.verify(vendorToken, process.env.JWT_SECRET);
      // The vendor JWT carries `userId` and has no `type` claim (see
      // middleware/auth.js) — checking for the ABSENCE of a buyer type is
      // what stops a buyer token being replayed here.
      if (decoded.userId && decoded.type !== "buyer") {
        const user = await User.findById(decoded.userId).select("_id").lean();
        if (user) {
          req.actor = { id: decoded.userId, type: "vendor" };
          return next();
        }
      }
    } catch {
      // Same reasoning — an invalid session is a guest, not an error.
    }
  }

  return next();
};
