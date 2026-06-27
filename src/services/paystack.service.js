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

export async function initializeTransaction({
  email,
  amount,
  reference,
  metadata = {},
  callbackUrl,
  subaccount,            // Paystack subaccount CODE (ACCT_...) — routes funds to a merchant
  transactionCharge,     // Velte commission in NAIRA — flat amount routed to the MAIN account
  channels = ["card"],   // default preserves subscription behaviour
}) {
  const payload = {
    email,
    // Paystack amount is in kobo (NGN) — multiply by 100
    amount: Math.round(amount * 100),
    reference,
    metadata,
    callback_url: callbackUrl,
    channels,
  };

  // Payment-link charges settle into the merchant's subaccount. The subaccount
  // was created with percentage_charge: 0 (platform takes nothing by default).
  // We bill the buyer a grossed-up total (product + commission + Paystack fee),
  // then:
  //   • transaction_charge routes Velte's flat commission to the MAIN account,
  //   • bearer: "subaccount" puts the Paystack fee on the merchant's share —
  //     but because the total was grossed up, the merchant still nets the full
  //     product price. See utils/commission.js + docs/commission-fees.md.
  if (subaccount) {
    payload.subaccount = subaccount;
    payload.bearer = "subaccount";
    if (transactionCharge != null && transactionCharge > 0) {
      // transaction_charge is in kobo and overrides the subaccount's split.
      payload.transaction_charge = Math.round(transactionCharge * 100);
    }
  }

  return paystackFetch("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify(payload),
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

// ── Subaccount lifecycle ───────────────────────────────────────────────────────
// Paystack has no delete endpoint — deactivate via active: false.

export async function updateSubaccount(idOrCode, payload) {
  return paystackFetch(`/subaccount/${encodeURIComponent(idOrCode)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function setSubaccountActive(idOrCode, active) {
  return updateSubaccount(idOrCode, { active });
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


/**
 * Create a Paystack transfer recipient for a bank account.
 * Returns the recipient_code needed to initiate a transfer.
 *
 * @param {object} params
 * @param {string} params.accountName   - Verified account name
 * @param {string} params.accountNumber - 10-digit NUBAN
 * @param {string} params.bankCode      - Paystack bank code e.g. "058"
 * @returns {Promise<string>} recipient_code
 */
export async function createTransferRecipient({ accountName, accountNumber, bankCode }) {
  const data = await paystackFetch("/transferrecipient", {
    method: "POST",
    body: JSON.stringify({
      type: "nuban",
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    }),
  });

  return data.recipient_code;
}

/**
 * Initiate a transfer from your Paystack balance to a recipient.
 *
 * @param {object} params
 * @param {string} params.recipientCode  - From createTransferRecipient()
 * @param {number} params.amountNaira    - Amount in NAIRA (converted to kobo here)
 * @param {string} params.reason         - Narration shown on recipient's statement
 * @param {string} params.reference      - Unique idempotency reference
 * @returns {Promise<{ transferCode: string, status: string }>}
 */
export async function initiateTransfer({ recipientCode, amountNaira, reason, reference }) {
  const data = await paystackFetch("/transfer", {
    method: "POST",
    body: JSON.stringify({
      source: "balance",
      reason,
      amount: Math.round(amountNaira * 100),
      recipient: recipientCode,
      reference,
    }),
  });

  return {
    transferCode: data.transfer_code,
    status: data.status, // "pending" | "success" | "failed" | "otp"
  };
}