// middlewares/authMiddleware.js
import jwt from "jsonwebtoken";
import User from "../models/Users.js";

export const verifyAuth = async (req, res, next) => {
  const token = req.cookies.auth_token;
  if (!token) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Session expired. Please log in again." });
  }

  let user;
  try {
    user = await User.findById(decoded.userId).select("isBlocked blockReason").lean();
    if (!user) {
      return res.status(401).json({ message: "Account not found. Please log in again." });
    }
  } catch {
    return res.status(500).json({ message: "Something went wrong." });
  }

  // Catches a block that happened mid-session (not just at login) — the
  // super admin panel can flip isBlocked on an already-logged-in user, so
  // this has to be re-checked on every authenticated request, not just once
  // at login time.
  if (user.isBlocked) {
    // Mirrors the clearCookie options used in auth.js's own logout() so this
    // actually removes the cookie (mismatched options silently no-op).
    res.clearCookie("auth_token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });
    return res.status(423).json({
      blocked: true,
      message: user.blockReason || "Your account has been blocked. Please contact support.",
    });
  }

  req.user = decoded;
  next();
};
