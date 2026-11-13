import jwt from "jsonwebtoken";
import User from "../models/Users.js";
import Buyer from "../models/Buyer.model.js";
import PlatformSubscription from "../models/PlatformSubscription.model.js";
import { resolveTier } from "../services/tier.service.js";

// GET /auth/me — "the single auth API" (2026-09-16). Used to be vendor-only,
// gated by verifyAuth (see routes/auth.js's own comment on why that's gone
// from this route now). Reads BOTH auth_token and buyer_auth_token itself
// and returns whichever resolve, together, in one response — trustworthy
// doing so because loginAsVendor and firebaseSignIn now pair or clear the
// OTHER cookie at login time (see identityLink.service.js), so the two
// cookies in a real request are guaranteed to already agree.
//
// ALWAYS 200s. A missing/invalid cookie of either kind resolves to `null`,
// never an error — a guest, or a buyer with no vendor account (or vice
// versa), is a normal answer here. A VENDOR cookie that verifies but fails
// to resolve (account deleted, or never verified) is reported as
// `vendorError` INSTEAD OF failing the whole response with a non-2xx —
// deliberately, so a lenient caller (src/app/api/auth/whoami/route.ts in
// the velte repo) still gets back whatever buyer data resolved
// successfully alongside it. The STRICT frontend route
// (src/app/api/auth/me/route.ts, gated locally by requireAuth() before it
// ever calls this) is what turns `vendorError` back into the 403/404 its
// own callers have always seen — that behavior moved to the frontend, not
// removed.
function isJwtError(err) {
  return (
    err?.name === "TokenExpiredError" ||
    err?.name === "JsonWebTokenError" ||
    err?.name === "NotBeforeError"
  );
}

export const profile = async (req, res, next) => {
  try {
    let vendor = null;
    let vendorError = null;
    const vendorToken = req.cookies?.auth_token;
    if (vendorToken) {
      let decoded = null;
      try {
        decoded = jwt.verify(vendorToken, process.env.JWT_SECRET);
      } catch (err) {
        // Expired or forged is "no vendor". A database failure is not —
        // swallowing it here made a signed-in person look logged out.
        if (!isJwtError(err)) throw err;
      }
      // Same check resolveActor.js's own vendor branch uses — the vendor
      // JWT carries `userId` and no `type` claim, which is what stops a
      // buyer token being replayed here.
      if (decoded?.userId && decoded.type !== "buyer") {
        const user = await User.findById(decoded.userId).select(
          "-password -emailOtp -changePasswordOtp",
        );
        if (!user) {
          vendorError = { status: 404, message: "User not found" };
        } else if (!user.accountVerified) {
          vendorError = {
            status: 403,
            message: "Your account is not verified. Please verify your email.",
            email: user.email,
          };
        } else {
          const tier = await resolveTier({ id: user._id, type: "vendor" });
          const sub = await PlatformSubscription.findOne({
            ownerId: user._id,
            ownerType: "vendor",
            status: { $in: ["trialing", "active", "past_due", "cancelled"] },
            currentPeriodEnd: { $gt: new Date() },
          })
            .lean()
            .catch(() => null);

          const rawVendor = user.toObject();
          delete rawVendor.password;
          delete rawVendor.requestPhoneOtp;
          delete rawVendor.requestPendingPhone;
          delete rawVendor.requestPhone;
          delete rawVendor.paystackSubaccount;
          delete rawVendor.blockReason;
          delete rawVendor.__v;
          if (rawVendor.verification) {
            delete rawVendor.verification.kycReference;
          }

          vendor = {
            ...rawVendor,
            tier,
            subscription: sub
              ? {
                  _id: sub._id,
                  plan: sub.plan,
                  status: sub.status,
                  interval: sub.interval,
                  currentPeriodEnd: sub.currentPeriodEnd,
                  trialEndsAt: sub.trialEndsAt ?? null,
                }
              : null,
          };
        }
      }
    }

    let buyer = null;
    const buyerToken = req.cookies?.buyer_auth_token;
    if (buyerToken) {
      let decoded = null;
      try {
        decoded = jwt.verify(buyerToken, process.env.JWT_SECRET);
      } catch (err) {
        if (!isJwtError(err)) throw err;
      }
      if (decoded?.type === "buyer" && decoded.buyerId) {
        const rawBuyer = await Buyer.findById(decoded.buyerId);
        if (rawBuyer) {
          const tier = await resolveTier({ id: rawBuyer._id, type: "buyer" });
          const sub = await PlatformSubscription.findOne({
            ownerId: rawBuyer._id,
            ownerType: "buyer",
            status: { $in: ["trialing", "active", "past_due", "cancelled"] },
            currentPeriodEnd: { $gt: new Date() },
          })
            .lean()
            .catch(() => null);

          const cleanBuyer = rawBuyer.toObject();
          delete cleanBuyer.__v;
          delete cleanBuyer.blockReason;

          buyer = {
            ...cleanBuyer,
            tier,
            subscription: sub
              ? {
                  _id: sub._id,
                  plan: sub.plan,
                  status: sub.status,
                  interval: sub.interval,
                  currentPeriodEnd: sub.currentPeriodEnd,
                  trialEndsAt: sub.trialEndsAt ?? null,
                }
              : null,
          };
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: { vendor, buyer, vendorError },
    });
  } catch (err) {
    next(err);
  }
};
