import jwt from "jsonwebtoken";
import User from "../models/Users.js";
import Buyer from "../models/Buyer.model.js";

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
export const profile = async (req, res) => {
  let vendor = null;
  let vendorError = null;
  const vendorToken = req.cookies?.auth_token;
  if (vendorToken) {
    try {
      const decoded = jwt.verify(vendorToken, process.env.JWT_SECRET);
      // Same check resolveActor.js's own vendor branch uses — the vendor
      // JWT carries `userId` and no `type` claim, which is what stops a
      // buyer token being replayed here.
      if (decoded.userId && decoded.type !== "buyer") {
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
          vendor = user;
        }
      }
    } catch {
      // Expired or forged — treated as no vendor session, not an error.
    }
  }

  let buyer = null;
  const buyerToken = req.cookies?.buyer_auth_token;
  if (buyerToken) {
    try {
      const decoded = jwt.verify(buyerToken, process.env.JWT_SECRET);
      if (decoded.type === "buyer" && decoded.buyerId) {
        buyer = await Buyer.findById(decoded.buyerId);
      }
    } catch {
      // Same treatment.
    }
  }

  return res.status(200).json({
    success: true,
    data: { vendor, buyer, vendorError },
  });
};
