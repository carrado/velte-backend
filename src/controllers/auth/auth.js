import jwt from "jsonwebtoken";
import User from "../../models/Users.js";
import { sendVerificationEmail } from "../../helpers/emailSender.js";


export const register = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      accountType,
      companyName,
      location,
      services,
      agreeToTerms
    } = req.body;

    // 🔹 Validate required fields
    if (!name || !email || !password || !accountType || !location) {
      return res.status(400).json({
        message:
          "Name, email, password, accountType and location are required fields",
      });
    }

    if (!["customer", "vendor"].includes(accountType)) {
      return res
        .status(400)
        .json({ message: 'Account type must be either "customer" or "vendor"' });
    }

    if (accountType === "vendor" && !companyName) {
      return res
        .status(400)
        .json({ message: "Company name is required for vendor accounts" });
    }

    // 🔹 Check if user already exists
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      if (existingUser.profile?.verified) {
        // ✅ User already verified — block registration
        return res.status(400).json({
          message: "User with this email already exists and is verified.",
        });
      } else {
        // 🔁 User exists but not verified — resend OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        existingUser.emailOtp = {
          code: otp,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        };

        await existingUser.save();

        await sendVerificationEmail(existingUser.email, existingUser.name, otp);

        return res.status(200).json({
          success: true,
          message:
            "An account with this email already exists but hasn’t been verified yet. A new verification code has been sent to your email — please verify your account to continue.",
        });
      }
    }

    // 🔹 Create a new user
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const user = new User({
      name,
      email,
      password,
      accountType,
      profile: {
        company: accountType === "vendor" ? companyName : null,
        location: location,
        services: services,
        verified: false,
      },
      emailOtp: {
        code: otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await user.save();

    // 🔹 Send verification email
    await sendVerificationEmail(email, name, otp);

    // 🔹 Generate auth token
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // 🔹 Set HttpOnly cookie
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      domain:
        process.env.NODE_ENV === "production" ? ".velte.ng" : "localhost",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({
      success: true,
      message:
        "Account created successfully. Please check your email for the 6-digit verification code.",
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred during registration.",
      error: error.message,
    });
  }
};



// Login controller
export const login = async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;

    // 🔹 Find user by email
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // 🔹 Check if user is verified
    if (!user.profile?.verified) {
      // Generate new OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      try {
        // Send verification email first
        await sendVerificationEmail(user.email, user.name, otp);

        // Update user OTP details
        user.emailOtp = {
          code: otp,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // valid for 10 mins
        };

        await user.save();

        return res.status(403).json({
          success: false,
          message:
            "Your account is not verified. A new verification code has been sent to your email.",
        });
      } catch (emailError) {
        console.error("Email send error:", emailError);
        return res.status(500).json({
          message:
            "Unable to send verification email at the moment. Please try again later.",
        });
      }
    }

    // 🔹 If verified, generate JWT token
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // 🔹 Set token in HttpOnly cookie
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      domain: process.env.NODE_ENV === "production" ? ".velte.ng" : "localhost",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // 🔹 Success response
    res.status(200).json({
      success: true,
      message: "Login successful",
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};