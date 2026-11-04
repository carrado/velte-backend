// What a buyer can add to a cart. The same four checks gate checkout,
// because a listing that became ineligible between add and pay must not
// silently charge.

/**
 * A listing is checkout-able only when ALL of these are true:
 *   - a physical product (not a service)
 *   - a single fixed Naira price (not a range, not quote-on-request)
 *   - not explicitly out of stock (quantity 0). Null quantity is untracked
 *     stock on listings that predate the field — cart still works once the
 *     vendor has a payout account. 0 is a real "sold out".
 *   - the vendor has a Paystack transfer recipient on file
 *
 * Services, ranges, and quote-on-request stay on the WhatsApp path.
 * @param {object} product  A Product document (or lean object)
 * @param {object | null} vendor  A User document with `payout` selected
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkoutEligibility(product, vendor) {
  if (!product || product.isSuspended) {
    return { ok: false, reason: "This listing isn't available." };
  }
  if (product.kind === "service" || product.quoteOnRequest) {
    return { ok: false, reason: "This is quoted per job — chat with the vendor." };
  }
  if (product.priceMax != null && product.priceMax > product.price) {
    return { ok: false, reason: "Price-range listings can't be checked out yet." };
  }
  if (product.currency && product.currency !== "NGN") {
    return { ok: false, reason: "Only naira listings can be checked out." };
  }
  if (product.quantity != null) {
    const stock = Number(product.quantity);
    if (!Number.isFinite(stock) || stock < 1) {
      return { ok: false, reason: "This listing is out of stock." };
    }
  }
  if (!vendor?.payout?.recipientCode) {
    return {
      ok: false,
      reason: "This vendor hasn't added a payout account yet.",
    };
  }
  return { ok: true };
}

export function isCheckoutEligible(product, vendor) {
  return checkoutEligibility(product, vendor).ok;
}
