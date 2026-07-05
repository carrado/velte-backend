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
import subscriptionRoutes from "./routes/subscription.routes.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import usersRoutes from "./routes/users.routes.js";
import productsRoutes from "./routes/products.routes.js";
import modifiersRoutes from "./routes/modifiers.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import walletRoutes from "./routes/wallet.routes.js";
import storeRoutes from "./routes/store.routes.js";
import searchRoutes from "./routes/search.routes.js";

const app = express();

// On Render (and similar PaaS) the app runs behind exactly ONE reverse proxy that
// sets X-Forwarded-For. Trust a single hop so req.ip is the real client IP — which
// express-rate-limit needs to key on (it errors when X-Forwarded-For is present but
// trust proxy is the default `false`). Deliberately `1`, not `true`: trusting every
// hop would let a client spoof X-Forwarded-For and slip the rate limiter.
app.set("trust proxy", 1);

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
  }),
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
    message: {
      success: false,
      message: "Too many requests, please try again later.",
    },
  }),
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
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/modifiers", modifiersRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/store", storeRoutes);
app.use("/api/search", searchRoutes);

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
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} (${env})`);
});
