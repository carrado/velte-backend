import jwt from "jsonwebtoken";
import User from "../models/Users.js";
import { sendVerificationEmail } from "../helpers/emailSender.js";

// Register controller
export const register = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      accountType,
      companyName,
      country,
      state,
    } = req.body;

    if (!name || !email || !password || !accountType || !country || !state) {
      return res.status(400).json({
        message:
          "Name, email, password, accountType, country and state are required fields",
      });
    }

    if (!["customer", "vendor"].includes(accountType)) {
      return res.status(400).json({
        message: 'Account Type must be either "customer" or "vendor"',
      });
    }

    if (accountType === "vendor" && !companyName) {
      return res.status(400).json({
        message: "Company name is required for vendor accounts",
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User with email address already exists" });
    }

    const user = new User({
      name,
      email,
      password,
      accountType,
      profile: {
        company: accountType === "vendor" ? companyName : null,
        location: { country, state },
      },
    });

    const verificationToken = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    await sendVerificationEmail(email, name, verificationToken);
    await user.save();

    // 🔹 Create main token for authentication
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // ✅ Set token as HttpOnly cookie
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // true for HTTPS
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      domain: process.env.NODE_ENV === 'production' ? '.velte.ng' : 'localhost',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const userData = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      accountType: user.accountType,
      profile: user.profile,
    };

    res.status(201).json({
      success: true,
      message:
        "Account created successfully. Please check your email for verification.",
      user: userData,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};



// Login controller
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // ✅ Set token in HttpOnly cookie
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // true for HTTPS
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      domain: process.env.NODE_ENV === 'production' ? '.velte.ng' : 'localhost',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const userData = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      accountType: user.accountType,
      profile: user.profile,
    };

    res.status(200).json({
      success: true,
      message: "Login successful",
      user: userData,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: error.message });
  }
};