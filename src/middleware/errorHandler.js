// src/middleware/errorHandler.js

/**
 * Operational error class — errors we expect and handle gracefully.
 * Non-operational errors (programming bugs, DB crashes) bubble up differently.
 */
export class AppError extends Error {
    constructor(message, statusCode) {
      super(message);
      this.statusCode = statusCode;
      this.status = statusCode >= 400 && statusCode < 500 ? "fail" : "error";
      this.isOperational = true;
      Error.captureStackTrace(this, this.constructor);
    }
  }
  
  /**
   * Global Express error handler.
   * Must be registered LAST with app.use().
   */
  export function errorHandler(err, req, res, _next) {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || "error";
  
    // Mongoose: duplicate key (e.g. unique userId constraint)
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue || {}).join(", ");
      err = new AppError(`Duplicate value for field: ${field}`, 409);
    }
  
    // Mongoose: validation error
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors).map((e) => e.message);
      err = new AppError(messages.join(". "), 400);
    }
  
    // Mongoose: invalid ObjectId
    if (err.name === "CastError") {
      err = new AppError(`Invalid value for field: ${err.path}`, 400);
    }
  
    // JWT errors (also caught in auth middleware, but belt-and-suspenders)
    if (err.name === "JsonWebTokenError") {
      err = new AppError("Invalid token.", 401);
    }
    if (err.name === "TokenExpiredError") {
      err = new AppError("Token expired. Please log in again.", 401);
    }
  
    const isDev = process.env.NODE_ENV === "development";
  
    // Development — include stack trace
    if (isDev) {
      return res.status(err.statusCode).json({
        success: false,
        status: err.status,
        message: err.message,
        stack: err.stack,
        err,
      });
    }
  
    // Production — only expose operational errors; hide internals
    if (err.isOperational) {
      return res.status(err.statusCode).json({
        success: false,
        status: err.status,
        message: err.message,
      });
    }
  
    // Programming/unknown error in production — don't leak details
    console.error("💥 UNHANDLED ERROR:", err);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Something went wrong. Please try again later.",
    });
  }
  
  /**
   * 404 handler — register before errorHandler.
   */
  export function notFound(req, _res, next) {
    next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
  }