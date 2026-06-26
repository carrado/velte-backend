import crypto from 'crypto';
import axios from 'axios';

/**
 * Dispatch a signed event to Staffly.
 * Always fire-and-forget — never await at the call site.
 *
 * @param {string} event         - Event type (e.g. 'order.created')
 * @param {string} phoneNumberId - AISetup.selectedNumberId for the merchant
 * @param {object} data          - Event-specific payload
 */
export async function dispatchToStaffly(event, phoneNumberId, data) {
  const url = process.env.STAFFLY_WEBHOOK_URL;
  const secret = process.env.VELTE_WEBHOOK_SECRET;

  if (!url || !secret) return;

  const body = JSON.stringify({ event, phoneNumberId, data });
  const signature =
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  try {
    // Send the EXACT bytes we signed (not a re-serialized object) so the HMAC
    // Staffly computes over the raw body always matches this signature.
    await axios.post(url, body, {
      headers: {
        'x-velte-signature': signature,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });
  } catch (err) {
    console.error('[Staffly] dispatch failed:', err.message);
  }
}

/**
 * Call a Staffly REST endpoint and RETURN its response (unlike dispatchToStaffly,
 * which is one-way fire-and-forget). Used for the vendor-confirmation flow where we
 * need the result back — fetch a held receipt's image, or post the vendor's
 * confirm/reject decision. Signed with the same shared secret + `x-velte-signature`.
 *
 * Base URL is STAFFLY_API_URL (e.g. http://localhost:8000/api/velte); if unset we
 * derive it from STAFFLY_WEBHOOK_URL by dropping the trailing `/webhook`.
 *
 * @param {string} path  - e.g. '/confirm-payment' or '/receipt-image'
 * @param {object} data  - JSON body
 * @returns {Promise<object>} parsed response data
 * @throws if not configured or the request fails (caller decides how to surface it)
 */
export async function callStaffly(path, data) {
  const secret = process.env.VELTE_WEBHOOK_SECRET;
  const base =
    process.env.STAFFLY_API_URL ||
    (process.env.STAFFLY_WEBHOOK_URL
      ? process.env.STAFFLY_WEBHOOK_URL.replace(/\/webhook\/?$/, '')
      : null);

  if (!base || !secret) {
    throw new Error('Staffly bridge not configured (STAFFLY_API_URL / secret)');
  }

  const body = JSON.stringify(data || {});
  const signature =
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  const url = `${base.replace(/\/$/, '')}${path}`;
  const res = await axios.post(url, body, {
    headers: {
      'x-velte-signature': signature,
      'Content-Type': 'application/json',
    },
    timeout: 15000, // receipt-image re-resolves + downloads media from Meta
  });
  return res.data;
}
