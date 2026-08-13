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
