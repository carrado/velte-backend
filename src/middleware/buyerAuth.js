import jwt from "jsonwebtoken";
import Buyer from "../models/Buyer.model.js";

// Mirrors middleware/auth.js's verifyAuth, but resolves against the Buyer
// collection via a separate cookie (`buyer_auth_token`, not `auth_token`) so
// a buyer session and a vendor session can coexist in the same browser
// without colliding. The `type: "buyer"` claim is checked as a second,
// independent guard — a vendor's token can never be replayed here even if
// cookie names were ever confused.
export const verifyBuyerAuth = async (req, res, next) => {
  const token = req.cookies.buyer_auth_token;
  if (!token) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res
      .status(401)
      .json({ success: false, message: "Session expired. Please verify again." });
  }

  if (decoded.type !== "buyer" || !decoded.buyerId) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }

  let buyer;
  try {
    buyer = await Buyer.findById(decoded.buyerId).select("_id").lean();
  } catch {
    return res.status(500).json({ success: false, message: "Something went wrong." });
  }
  if (!buyer) {
    return res
      .status(401)
      .json({ success: false, message: "Account not found. Please verify again." });
  }

  req.buyer = decoded;
  next();
};

// The same check, but never fails the request — for endpoints that must work
// for an anonymous caller AND behave differently for a signed-in one.
// Sets req.buyer when a valid session exists, leaves it undefined otherwise.
//
// Used by the OTP endpoints (2026-08-26): a buyer with no account is
// verifying a phone to CREATE one, while a buyer already signed in with
// Google is ATTACHING a phone to the account they already have. Same two
// endpoints, and the difference is exactly whether a session is present.
export const attachBuyerIfPresent = async (req, _res, next) => {
  const token = req.cookies?.buyer_auth_token;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== "buyer" || !decoded.buyerId) return next();
    const buyer = await Buyer.findById(decoded.buyerId).select("_id").lean();
    if (buyer) req.buyer = decoded;
  } catch {
    // An expired or malformed cookie simply means "not signed in" here —
    // never an error, since every caller of this works fine without one.
  }
  next();
};

// Authorises POST /buyer-requests, which has TWO legitimate callers since
// 2026-08-27:
//
//   - a signed-in buyer (`buyer_auth_token`), or
//   - anyone holding a `phoneToken` from verify-otp — proof of one number,
//     for one request, from someone with no account at all.
//
// The second is why this exists. Verifying a phone stopped creating a Buyer
// (see buyerAuth.controller.js), so `verifyBuyerAuth` alone would now lock
// anonymous buyers out of the reach-out flow entirely — which is the one
// thing on Velte an anonymous buyer most needs to be able to do.
//
// Sets req.buyer (session) and/or req.verifiedPhone. Rejects only when
// NEITHER is present, so the controller can trust that at least one identity
// signal survived.
export const requireBuyerOrVerifiedPhone = async (req, res, next) => {
  const token = req.cookies?.buyer_auth_token;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.type === "buyer" && decoded.buyerId) {
        const buyer = await Buyer.findById(decoded.buyerId).select("_id").lean();
        if (buyer) req.buyer = decoded;
      }
    } catch {
      // Expired or malformed — fall through to the phone token, which may
      // still be perfectly valid on its own.
    }
  }

  const phoneToken = req.body?.phoneToken;
  if (typeof phoneToken === "string" && phoneToken) {
    try {
      const decoded = jwt.verify(phoneToken, process.env.JWT_SECRET);
      // The `type` check is what stops a buyer session cookie being replayed
      // here as a phone proof, or vice versa — they're signed with the same
      // secret, so the claim is the only thing separating them.
      if (decoded.type === "phone_verified" && decoded.phone) {
        req.verifiedPhone = decoded.phone;
      }
    } catch {
      // Same: an expired proof is simply no proof.
    }
  }

  if (!req.buyer && !req.verifiedPhone) {
    return res
      .status(401)
      .json({ success: false, message: "Verify your phone number first." });
  }
  next();
};
