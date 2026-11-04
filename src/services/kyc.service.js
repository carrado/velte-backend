// Identity verification (Phase 1.1 of docs/velte-platform-plan.md).
//
// Provider is Ninja (Q8, 2026-10-15): NIN for buyers, NIN + CAC for
// vendors. The NIN step is a hosted flow with selfie match on and
// liveness off. First check absorbed by Velte; a re-check costs
// KYC_RECHECK_CREDITS. See config/prices.js for the published rates.
//
// This module is the seam: startVerification / readResult talk to Ninja,
// and nothing else imports their SDK. Until NINJA_SECRET_KEY is set, both
// functions refuse with a clear 503 rather than pretending a check ran.
//
// Live:   https://api.ninja.boucloud.io
// Sandbox: https://api.sandbox.ninja.boucloud.io
// Auth:   Authorization: Bearer sk_... (server only; never a browser).

import { AppError } from "../middleware/errorHandler.js";

export function isKycConfigured() {
  return Boolean(process.env.NINJA_SECRET_KEY);
}

export async function startVerification({ ownerId, ownerType, nin }) {
  if (!isKycConfigured()) {
    throw new AppError(
      "Identity verification is not available yet. Try again later.",
      503,
    );
  }
  if (typeof nin !== "string" || !/^\d{11}$/.test(nin.trim())) {
    throw new AppError("NIN must be 11 digits.", 400);
  }
  const flowId = process.env.NINJA_KYC_FLOW_ID;
  if (!flowId) {
    throw new AppError(
      "Identity verification is not available yet. Try again later.",
      503,
    );
  }

  const base = (
    process.env.NINJA_API_BASE || "https://api.ninja.boucloud.io"
  ).replace(/\/+$/, "");
  const res = await fetch(`${base}/api/flows/${flowId}/links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NINJA_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customer_ref: `${ownerType}:${ownerId}`,
      // The hosted flow compares a selfie. Liveness stays off on the flow.
      nin: nin.trim(),
    }),
  });
  const body = await res.json().catch(() => null);
  const url = body?.url || body?.link || body?.data?.url || null;
  if (!res.ok || !url) {
    throw new AppError(
      "Identity verification could not be started. Try again later.",
      502,
    );
  }
  return {
    url,
    reference: body?.id || body?.reference || body?.data?.id || null,
  };
}

export async function readResult(providerReference) {
  if (!isKycConfigured()) {
    throw new AppError(
      "Identity verification is not available yet. Try again later.",
      503,
    );
  }
  void providerReference;
  throw new AppError("Identity verification provider is not wired yet.", 503);
}
