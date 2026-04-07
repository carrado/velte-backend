import jwt from "jsonwebtoken";
import User from "../../models/Users.js";
import { sendVerificationEmail } from "../../helpers/emailSender.js";
import Subscription from "../../models/Subscriptions.js";


export const register = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      businessName,
      services,
      country,
      address,
      username,
      agreeToTerms,
    } = req.body;

    // 🔹 Validate required fields
    if (!name || !email || !password || !businessName || !username) {
      return res.status(400).json({
        message:
          "Name, email, password, business name and username are required fields",
      });
    }

    // 🔹 Check if user already exists
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      if (existingUser.accountVerified) {
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
      company: {
        name: businessName,
        location: address,
        services: services,
      },
      username,
      country: country,
      emailOtp: {
        code: otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await user.save();

    const startsAt = new Date();
    const expiresAt = new Date(startsAt);
    expiresAt.setDate(expiresAt.getDate() + 2);

    // 🔹 Send verification email
    await sendVerificationEmail(email, name, otp);

    await Subscription.create({
      businessId: user._id,
      plan: "free",
      status: "active",
      startsAt,
      expiresAt,
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
    if (!user.accountVerified) {
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
      secure:
        process.env.NODE_ENV === "production" ||
        process.env.NODE_ENV === "staging",
      sameSite:
        process.env.NODE_ENV === "production" ||
        process.env.NODE_ENV === "staging"
          ? "none"
          : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // 🔹 Success response
    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        country: user.country,
        company: {
          name: user.company?.name,
          location: user.company?.location,
          services: user.company?.services || [],
        },
        accountVerified: user.accountVerified,
        username: user.username,
      },
      message: "Login successful",
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};







export const logout = async (req, res) => {
  try {
    res.clearCookie("auth_token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });

    return res.status(200).json({
      success: true,
      message: "Logout successful",
    });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};









export const verifyEmail = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    // Find the user by email
    const user = await User.findOne({ email });

    if (user.accountVerified) {
      return res.status(400).json({ message: "The user is already verified." });
    }


    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if OTP exists and matches
    if (!user.emailOtp || user.emailOtp.code !== Number(otp)) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // Check if OTP is expired
    const now = new Date();
    if (user.emailOtp.expiresAt < now) {
      return res.status(400).json({ message: "OTP has expired" });
    }

    // Mark user as verified
    user.accountVerified = true;

    // Remove OTP after verification (optional)
    user.emailOtp = undefined;

    await user.save();

    res.status(201).json({ message: "Account verified successfully" });
  } catch (err) {
    console.error("Email verification error:", err);
    res.status(500).json({ message: "Something went wrong" });
  }
};







export const deleteAccount = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { password } = req.body; // Get password from request body

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required for account deletion",
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Incorrect password",
      });
    }

    // Set accountStatus to false (soft delete)
    user.activeStatus = false;
    await user.save();

    // Clear the auth cookie
    res.clearCookie("auth_token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      domain: process.env.NODE_ENV === "production" ? ".velte.ng" : "localhost",
    });

    res.status(200).json({
      success: true,
      message: "Account deactivated successfully.",
    });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while deactivating your account",
      error: error.message,
    });
  }
};








export const verifyPasswordOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    // Find the user by email
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if OTP exists and matches
    if (!user.emailOtp || user.emailOtp.code !== Number(otp)) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // Check if OTP is expired
    const now = new Date();
    if (user.emailOtp.expiresAt < now) {
      return res.status(400).json({ message: "OTP has expired" });
    }

    await user.save();

    res.status(201).json({ message: "OTP verified successfully" });
  } catch (err) {
    console.error("Email verification error:", err);
    res.status(500).json({ message: "Something went wrong" });
  }
};






export const resetPassword = async (req, res) => {
  try {
    const { email, otp, password } = req.body;

    // 🔹 Validate required fields
    if (!email || !otp || !password) {
      return res.status(400).json({
        message: "Email, OTP, and new password are required",
      });
    }

    // 🔹 Validate new password length
    if (password.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters long",
      });
    }

    // 🔹 Find the user by email
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // 🔹 Check if OTP exists and matches
    if (!user.emailOtp || user.emailOtp.code !== Number(otp)) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    // 🔹 Check if OTP is expired
    const now = Date.now();
    if (user.emailOtp.expiresAt < now) {
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new one.",
      });
    }

    // 🔹 Check if new password is same as old password
    const isSamePassword = await user.comparePassword(password);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: "Unable to reset password. Please try again.",
      });
    }

    // 🔹 Update password
    user.password = password;

    // 🔹 Clear OTP after successful password reset
    user.emailOtp = undefined;

    // 🔹 Save user (password will be hashed by pre-save hook)
    await user.save();

    // 🔹 Send success response
    res.status(200).json({
      success: true,
      message:
        "Password reset successful. You can now login with your new password.",
    });
  } catch (error) {
    console.error("Password reset error:", error);

    // Handle specific errors
    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Invalid input data",
      });
    }

    res.status(500).json({
      success: false,
      message: "An error occurred while resetting password",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
