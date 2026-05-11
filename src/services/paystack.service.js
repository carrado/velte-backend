// src/services/paystack.service.js
// Thin wrapper around the Paystack API.
// All secrets stay server-side — the client never calls Paystack directly.

const PAYSTACK_BASE = "https://api.paystack.co";

function paystackHeaders() {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not configured");
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

async function paystackFetch(path, options = {}) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    ...options,
    headers: {
      ...paystackHeaders(),
      ...(options.headers || {}),
    },
  });

  const data = await res.json();

  if (!res.ok || !data.status) {
    throw new Error(data.message || `Paystack request failed: ${path}`);
  }

  return data.data;
}

// ── Initialize transaction ────────────────────────────────────────────────────
// Creates a Paystack checkout session.
// Returns { authorization_url, access_code, reference }

export async function initializeTransaction({ email, amount, reference, metadata = {} }) {
  return paystackFetch("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email,
      // Paystack amount is in kobo (NGN) — multiply by 100
      amount: Math.round(amount * 100),
      reference,
      metadata,
      channels: ["card"],
    }),
  });
}

// ── Verify transaction ────────────────────────────────────────────────────────
// Called after the user completes (or closes) the Paystack popup.
// Returns the full transaction object from Paystack.

export async function verifyTransaction(reference) {
  return paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
}

// ── Fetch customer ────────────────────────────────────────────────────────────

export async function fetchCustomer(emailOrCode) {
  return paystackFetch(`/customer/${encodeURIComponent(emailOrCode)}`);
}

// ── Create customer ───────────────────────────────────────────────────────────

export async function createCustomer({ email, firstName, lastName }) {
  return paystackFetch("/customer", {
    method: "POST",
    body: JSON.stringify({ email, first_name: firstName, last_name: lastName }),
  });
}

// ── Validate webhook signature ────────────────────────────────────────────────
// Paystack signs webhook payloads with HMAC-SHA512.
// Always call this before trusting any webhook body.

import crypto from "crypto";

export function validateWebhookSignature(rawBody, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not configured");

  const expected = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");

  // timingSafeEqual prevents timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex"),
  );
}