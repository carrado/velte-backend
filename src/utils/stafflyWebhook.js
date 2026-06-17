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
    await axios.post(url, JSON.parse(body), {
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
