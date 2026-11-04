import jwt from "jsonwebtoken";

import { AppError } from "./errorHandler.js";
import Buyer from "../models/Buyer.model.js";

// The buyer Hub asks for the buyer even when that Google account is linked
// to a vendor. resolveActor would otherwise hand the request to the vendor.
export async function asBuyerAudience(req, _res, next) {
  if (req.query.audience !== "buyer") return next();
  try {
    const token = req.cookies?.buyer_auth_token;
    if (!token) {
      throw new AppError("Sign in to open the Hub.", 401, {
        code: "auth_required",
      });
    }
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      throw new AppError("Sign in to open the Hub.", 401, {
        code: "auth_required",
      });
    }
    if (decoded.type !== "buyer" || !decoded.buyerId) {
      throw new AppError("Sign in to open the Hub.", 401, {
        code: "auth_required",
      });
    }
    const buyer = await Buyer.findById(decoded.buyerId).select("_id").lean();
    if (!buyer) {
      throw new AppError("Sign in to open the Hub.", 401, {
        code: "auth_required",
      });
    }
    req.actor = { id: String(buyer._id), type: "buyer" };
    next();
  } catch (err) {
    next(err);
  }
}
