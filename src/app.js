import dotenv from "dotenv-flow";

dotenv.config();

import express from "express";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRoutes from "./routes/auth.js";

const app = express();

// Detect current environment
const env = process.env.NODE_ENV || "development";

// Middleware
app.use(
  cors({
    // origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    origin: [
      "http://localhost:4001",
      "https://velte-frontend.netlify.app",
      "https://velte.ng",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

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
// app.use('/api/events', eventRoutes);
// app.use('/api/tickets', ticketRoutes);

// Health check route
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    environment: env,
    database: env === "production" ? "Production DB" : "Staging DB",
    timestamp: new Date().toISOString(),
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Server Error:", err.stack);
  res.status(500).json({ message: "Something went wrong!" });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} (${env})`);
});
