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
import transactionRoutes from "./routes/transactions.routes.js";
import customersRoutes from "./routes/customers.routes.js";
import pushRoutes from "./routes/push.routes.js";
import notificationRoutes from "./routes/notifications.routes.js";
import usersRoutes from "./routes/users.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import payRoutes from "./routes/pay.routes.js";
import trackRoutes from "./routes/track.routes.js";
import productsRoutes from "./routes/products.routes.js";
import modifiersRoutes from "./routes/modifiers.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";

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

// Paystack posts webhooks as application/json and signs the RAW request body.
// This route MUST see the unparsed bytes to verify the HMAC signature, so it has
// to bypass the global express.json() below — otherwise the JSON parser consumes
// the stream first, req.body becomes a parsed object, the signature check runs
// over the wrong data, fails (401), and no order is ever created. Mounting
// express.raw() for this exact path first leaves req.body as a Buffer and flags
// the body as already read, so the global express.json() then skips it.
app.use("/api/subscription/webhook", express.raw({ type: "application/json" }));

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
app.use("/api/transactions", transactionRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/pay", payRoutes); // public pay-page endpoints (no auth)
app.use("/api/track", trackRoutes); // public order-tracking endpoint (no auth)
app.use("/api/products",   productsRoutes);
app.use("/api/modifiers",  modifiersRoutes);
app.use("/api/categories", categoriesRoutes);


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
