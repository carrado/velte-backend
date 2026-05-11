import dotenv from "dotenv-flow";

dotenv.config();

import express from "express";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import authRoutes from "./routes/auth.js";
import aiSetupRoutes from "./routes/aiSetup.routes.js";
import subscriptionRoutes from "./routes/subscription.routes.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";

const app = express();

app.use(helmet());
app.use(hpp());


// Detect current environment
const env = process.env.NODE_ENV || "development";

// Middleware
app.use(
  cors({
    // origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    origin: [
      "http://localhost:4001",
      "https://velte-dev.vercel.app",
      "https://velte.ng",
    ],
    credentials: true,
  })
);

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());


app.use(mongoSanitize());


app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests, please try again later." },
  })
);



// Determine which MongoDB URI to use
let dbUri = "";

if (env === "production") {
  // Live site (velte.ng)
  dbUri = process.env.MONGODB_URI_PRODUCTION;
} else {
  // Localhost + Staging share same DB
  dbUri = process.env.MONGODB_URI;
}

// Connect to MongoDB
mongoose
  .connect(dbUri)
  .then(() => console.log(`✅ Connected to MongoDB (${env})`))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));


// Routes
app.use("/api/auth", authRoutes);
app.use("/api/ai-setup", aiSetupRoutes);
app.use("/api/subscription", subscriptionRoutes);


// Health check route
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    hasToken: !!req.cookies.auth_token,
    authToken: req.cookies.auth_token || null,
    environment: env,
    database: env === "production" ? "Production DB" : "Staging DB",
    timestamp: new Date().toISOString(),
  });
});


app.use(notFound);
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} (${env})`);
});
