// Velte commission + Paystack gross-up. Source of truth for what the buyer is
// charged on the public pay page. Mirrors the frontend reference implementation
// (velte: src/lib/commission.ts) and the policy in velte docs/commission-fees.md.
//
// Model: buyer pays  total = productPrice (X) + commission (C) + paystackFee (F).
// The transaction routes C to Velte's main account (transaction_charge) and the
// fee to the seller's subaccount (bearer: "subaccount"); because the total is
// grossed up, the seller still nets the full product price X.

// Paystack (Nigeria, local cards/transfer). Keep in sync with the live contract.
const PAYSTACK_RATE = 0.015;
const PAYSTACK_FLAT = 100;
const PAYSTACK_FLAT_WAIVER = 2500; // flat ₦100 is waived when total < this
const PAYSTACK_CAP = 2000; // Paystack fee never exceeds this

/**
 * Velte's flat commission for a given product price (NGN).
 * See docs/commission-fees.md §2.
 * @param {number} price
 * @returns {number}
 */
export function commissionForPrice(price) {
  if (price <= 0) return 0;
  if (price < 10_000) return 300;
  if (price <= 20_000) return 500;
  if (price <= 50_000) return 700;
  if (price <= 100_000) return 1_000;
  if (price <= 500_000) return 2_000;
  if (price <= 1_000_000) return 4_000;
  return 5_000;
}

/**
 * Gross up the product price so that, after Paystack takes its cut, the seller
 * receives the full product price and Velte keeps its full commission — with the
 * buyer covering Paystack's fee. See docs/commission-fees.md §3.
 *
 * @param {number} productPrice  Agreed product price (X), in NGN.
 * @returns {{ productPrice: number, commission: number, paystackFee: number, serviceFee: number, total: number }}
 */
export function computeCharge(productPrice) {
  const x = Math.max(0, Math.round(Number(productPrice) || 0));
  const commission = commissionForPrice(x);

  // Standard regime: Paystack charges rate% + flat ₦100.
  let total = (x + commission + PAYSTACK_FLAT) / (1 - PAYSTACK_RATE);

  // Under the waiver threshold Paystack drops the flat fee — re-solve without it.
  if (total < PAYSTACK_FLAT_WAIVER) {
    total = (x + commission) / (1 - PAYSTACK_RATE);
  }

  let paystackFee = total - x - commission;

  // Cap: the fee is fixed at the cap and the total is simply X + C + cap.
  if (paystackFee > PAYSTACK_CAP) {
    paystackFee = PAYSTACK_CAP;
    total = x + commission + PAYSTACK_CAP;
  }

  // Charge whole naira — round up so seller + commission stay whole.
  total = Math.ceil(total);
  paystackFee = total - x - commission;

  return {
    productPrice: x,
    commission,
    paystackFee,
    serviceFee: commission + paystackFee, // = total - x
    total,
  };
}
