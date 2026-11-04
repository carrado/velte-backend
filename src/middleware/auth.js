// middlewares/authMiddleware.js
import jwt from "jsonwebtoken";
import User from "../models/Users.js";
import { AppError } from "./errorHandler.js";
import { clearSessionCookieOptions } from "../utils/authCookies.js";

export const verifyAuth = async (req, res, next) => {
  const token = req.cookies.auth_token;
  if (!token) {
    return next(new AppError("Not authenticated", 401));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next(new AppError("Session expired. Please log in again.", 401));
  }

  let user;
  try {
    user = await User.findById(decoded.userId).select("isBlocked blockReason").lean();
  } catch (err) {
    return next(err);
  }
  if (!user) {
    return next(new AppError("Account not found. Please log in again.", 401));
  }

  // Catches a block that happened mid-session (not just at login) — the
  // super admin panel can flip isBlocked on an already-logged-in user, so
  // this has to be re-checked on every authenticated request, not just once
  // at login time.
  if (user.isBlocked) {
    res.clearCookie("auth_token", clearSessionCookieOptions());
    return next(
      new AppError(
        user.blockReason || "Your account has been blocked. Please contact support.",
        423,
        { blocked: true },
      ),
    );
  }

  req.user = decoded;
  next();
};
