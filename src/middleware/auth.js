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

  try {
    const exists = await User.exists({ _id: decoded.userId });
    if (!exists) {
      return res.status(401).json({ message: "Account not found. Please log in again." });
    }
  } catch {
    return res.status(500).json({ message: "Something went wrong." });
  }

  req.user = decoded;
  next();
};
