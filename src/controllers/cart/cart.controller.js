// Cart checkout. A cart is one vendor; an order is one vendor. The buyer
// pays Velte (escrow); the vendor is transferred after they confirm.
//
// Stock is decremented on payment, not on initialize — a cart that never
// pays must not empty the shelf. Eligibility is re-checked at initialize
// AND at payment, because a listing can lose its payout account or its last
// unit between those two moments.

import crypto from "crypto";
import mongoose from "mongoose";
import Buyer from "../../models/Buyer.model.js";
import User from "../../models/Users.js";
import Product from "../../models/Product.model.js";
import Order from "../../models/Order.model.js";
import Review from "../../models/Review.model.js";
import Store from "../../models/Store.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { computeCharge } from "../../utils/commission.js";
import { checkoutEligibility } from "../../utils/cartEligibility.js";
import {
  initializeTransaction,
  verifyTransaction,
} from "../../services/paystack.service.js";
import { notifyUser } from "../../services/pushNotification.service.js";

function frontendBase() {
  return (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
}

const NG_MOBILE = /^234[789]\d{9}$/;

function normalizeNgMobile(raw) {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  if (!digits) return null;
  let n = digits;
  if (n.startsWith("234")) {
    // already international
  } else if (n.startsWith("0")) {
    n = `234${n.slice(1)}`;
  } else if (n.length === 10) {
    n = `234${n}`;
  } else {
    return null;
  }
  return NG_MOBILE.test(n) ? n : null;
}

function parseFulfillment(input) {
  const name = String(input?.name ?? "").trim();
  const address = String(input?.address ?? "").trim();
  const phone = normalizeNgMobile(input?.phone);
  if (name.length < 2 || name.length > 80) {
    throw new AppError("Tell us who this order is for (your name).", 400);
  }
  if (!phone) {
    throw new AppError(
      "Add a Nigerian phone number the vendor can reach you on.",
      400,
    );
  }
  if (address.length < 8 || address.length > 300) {
    throw new AppError(
      "Add a delivery address the vendor can find — street, area, landmark.",
      400,
    );
  }
  return { name, phone, address };
}

function presentFulfillment(fulfillment) {
  if (!fulfillment?.name || !fulfillment?.phone || !fulfillment?.address) {
    return null;
  }
  return {
    name: fulfillment.name,
    phone: fulfillment.phone,
    address: fulfillment.address,
  };
}

function presentOrder(order, store) {
  return {
    id: String(order._id),
    buyerId: String(order.buyerId),
    vendorId: String(order.vendorId),
    vendorName: order.vendorName || store?.name || null,
    storeHandle: order.storeHandle || store?.handle || null,
    items: order.items.map((item) => ({
      productId: String(item.productId),
      name: item.name,
      imageUrl: item.imageUrl,
      unitPriceKobo: item.unitPriceKobo,
      quantity: item.quantity,
      lineTotalKobo: item.lineTotalKobo,
    })),
    subtotalKobo: order.subtotalKobo,
    commissionKobo: order.commissionKobo,
    paystackFeeKobo: order.paystackFeeKobo,
    serviceFeeKobo: order.commissionKobo + order.paystackFeeKobo,
    totalKobo: order.totalKobo,
    status: presentStatus(order),
    settlement: presentSettlement(order),
    paystackReference: order.paystackReference,
    paidAt: order.paidAt,
    acceptedAt: order.acceptedAt ?? null,
    dispatchedAt: order.dispatchedAt ?? null,
    deliveredAt: order.deliveredAt ?? null,
    confirmBy: order.confirmBy ?? null,
    receivedAt: order.receivedAt ?? null,
    confirmedAt: order.confirmedAt,
    pickupCode: order.pickupCode ?? null,
    dispatch: order.dispatch ?? null,
    createdAt: order.createdAt,
    fulfillment: presentFulfillment(order.fulfillment),
    vendorReviewed: false,
    productReviewedIds: [],
  };
}

// Legacy `confirmed` + a transfer already sent reads as received + released
// so the UI never offers a second payout.
function presentStatus(order) {
  if (order.status === "confirmed" && order.transferReference) return "received";
  return order.status;
}

function presentSettlement(order) {
  if (order.settlement && order.settlement !== "none") return order.settlement;
  if (order.status === "confirmed" && order.transferReference) return "released";
  if (order.status === "paid" || order.status === "accepted") return "escrowed";
  return order.settlement || "none";
}

async function presentOrders(orders) {
  const missing = [
    ...new Set(
      orders
        .filter((order) => !order.vendorName)
        .map((order) => String(order.vendorId)),
    ),
  ];
  const stores =
    missing.length === 0
      ? []
      : await Store.find({ vendorId: { $in: missing } }).select(
          "vendorId name handle",
        );
  const byVendor = new Map(
    stores.map((store) => [String(store.vendorId), store]),
  );
  const orderIds = orders.map((order) => order._id);
  const reviewRows =
    orderIds.length === 0
      ? []
      : await Review.find({ orderId: { $in: orderIds } })
          .select("orderId kind productId")
          .lean();
  const vendorReviewed = new Set();
  const productReviewed = new Map();
  for (const row of reviewRows) {
    const orderKey = String(row.orderId);
    if (row.kind === "product" && row.productId) {
      const set = productReviewed.get(orderKey) ?? new Set();
      set.add(String(row.productId));
      productReviewed.set(orderKey, set);
    } else {
      vendorReviewed.add(orderKey);
    }
  }
  return orders.map((order) => {
    const key = String(order._id);
    return {
      ...presentOrder(order, byVendor.get(String(order.vendorId))),
      vendorReviewed: vendorReviewed.has(key),
      productReviewedIds: [...(productReviewed.get(key) ?? [])],
    };
  });
}

async function loadCheckoutableItems(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new AppError("Add at least one item to check out.", 400);
  }
  if (lines.length > 20) {
    throw new AppError("A cart can hold 20 items at most.", 400);
  }

  const parsed = lines.map((line, i) => {
    const productId = String(line?.productId ?? "").trim();
    const quantity = Number(line?.quantity);
    if (!mongoose.isValidObjectId(productId)) {
      throw new AppError(`Item ${i + 1} is not a valid listing.`, 400);
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new AppError(`Item ${i + 1} needs a quantity of 1 or more.`, 400);
    }
    return { productId, quantity };
  });

  const products = await Product.find({
    _id: { $in: parsed.map((l) => l.productId) },
  });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const vendorIds = new Set();
  const items = [];

  for (const line of parsed) {
    const product = byId.get(line.productId);
    if (!product) throw new AppError("One of those listings no longer exists.", 400);
    vendorIds.add(String(product.vendorId));
    items.push({ product, quantity: line.quantity });
  }

  if (vendorIds.size !== 1) {
    throw new AppError("A cart can only hold listings from one store.", 400);
  }

  const vendorId = [...vendorIds][0];
  const vendor = await User.findById(vendorId).select("+payout name company");
  if (!vendor) throw new AppError("That store no longer exists.", 404);

  for (const { product, quantity } of items) {
    const gate = checkoutEligibility(product, vendor);
    if (!gate.ok) throw new AppError(gate.reason, 400);
    if (product.quantity != null && product.quantity < quantity) {
      throw new AppError(
        `${product.name} only has ${product.quantity} left.`,
        400,
      );
    }
  }

  return { vendor, items };
}

function quoteItems(items) {
  const quoted = items.map(({ product, quantity }) => {
    const unitPriceKobo = product.price;
    return {
      productId: product._id,
      name: product.name,
      imageUrl: product.mainImageUrl,
      unitPriceKobo,
      quantity,
      lineTotalKobo: unitPriceKobo * quantity,
    };
  });
  const subtotalKobo = quoted.reduce((sum, item) => sum + item.lineTotalKobo, 0);
  const charge = computeCharge(subtotalKobo / 100);
  return {
    items: quoted,
    subtotalKobo,
    commissionKobo: charge.commission * 100,
    paystackFeeKobo: charge.paystackFee * 100,
    totalKobo: charge.total * 100,
  };
}

const MAX_ADD_QTY = 10;
const ADD_IDEMPOTENCY_TTL_MS = 2 * 60 * 1000;
const recentAdds = new Map();

function rememberAdd(key, data) {
  recentAdds.set(key, { at: Date.now(), data });
  if (recentAdds.size > 200) {
    const cutoff = Date.now() - ADD_IDEMPOTENCY_TTL_MS;
    for (const [k, v] of recentAdds) {
      if (v.at < cutoff) recentAdds.delete(k);
    }
  }
}

function recallAdd(key) {
  const hit = recentAdds.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ADD_IDEMPOTENCY_TTL_MS) {
    recentAdds.delete(key);
    return null;
  }
  return hit.data;
}

function presentModifierGroups(product) {
  return (product.modifiers ?? [])
    .map((group) => {
      const options = (group.options ?? [])
        .filter((opt) => opt && typeof opt === "object" && opt.name)
        .map((opt) => ({
          optionId: String(opt._id),
          name: opt.name,
          additionalPrice: Number(opt.additionalPrice) || 0,
        }));
      if (options.length === 0) return null;
      return {
        groupId: String(group._id),
        name: group.name,
        required: Boolean(group.required),
        multiSelect: Boolean(group.multiSelect),
        options,
      };
    })
    .filter(Boolean);
}

function matchOptionPicks(groups, picks) {
  const selected = [];
  const remaining = groups.filter((g) => g.required);

  for (const pick of Array.isArray(picks) ? picks : []) {
    const groupName = String(pick?.groupName ?? pick?.group ?? "")
      .trim()
      .toLowerCase();
    const optionName = String(pick?.optionName ?? pick?.option ?? "")
      .trim()
      .toLowerCase();
    if (!groupName || !optionName) continue;
    const group = groups.find((g) => g.name.trim().toLowerCase() === groupName);
    if (!group) continue;
    const option = group.options.find(
      (o) => o.name.trim().toLowerCase() === optionName,
    );
    if (!option) continue;
    selected.push({
      group: group.name,
      option: option.name,
      additionalPrice: option.additionalPrice,
    });
    const idx = remaining.findIndex((g) => g.groupId === group.groupId);
    if (idx >= 0) remaining.splice(idx, 1);
  }

  return { selected, missing: remaining };
}

// ── POST /api/cart/validate-add ──────────────────────────────────────────────
// Body: { productId, quantity, options?, clientRequestId? }
// Loads price, stock and vendor status from the database. The model never
// supplies those — this is what makes an AI add-to-cart call safe.

export async function validateCartAdd(req, res, next) {
  try {
    const productId = String(req.body?.productId ?? "").trim();
    const quantity = Number(req.body?.quantity ?? 1);
    const clientRequestId = String(req.body?.clientRequestId ?? "")
      .trim()
      .slice(0, 80);
    const buyerId = String(req.buyer?.buyerId ?? "");

    if (!mongoose.isValidObjectId(productId)) {
      throw new AppError("That listing isn't on Velte.", 400);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ADD_QTY) {
      throw new AppError(`Quantity must be between 1 and ${MAX_ADD_QTY}.`, 400);
    }

    if (buyerId && clientRequestId) {
      const cached = recallAdd(`${buyerId}:${clientRequestId}`);
      if (cached) {
        return res.json({ success: true, data: cached });
      }
    }

    const product = await Product.findById(productId).populate(
      "modifiers.options",
    );
    if (!product) throw new AppError("That listing no longer exists.", 404);

    const vendor = await User.findById(product.vendorId).select(
      "+payout name company",
    );
    const store = await Store.findOne({ vendorId: product.vendorId }).select(
      "name",
    );
    const vendorName =
      store?.name || vendor?.company?.name || vendor?.name || "Store";

    const gate = checkoutEligibility(product, vendor);
    if (!gate.ok) {
      const data = { status: "ineligible", reason: gate.reason };
      if (buyerId && clientRequestId) rememberAdd(`${buyerId}:${clientRequestId}`, data);
      return res.json({ success: true, data });
    }

    if (product.quantity != null && product.quantity < quantity) {
      const data = {
        status: "ineligible",
        reason: `${product.name} only has ${product.quantity} left.`,
      };
      if (buyerId && clientRequestId) rememberAdd(`${buyerId}:${clientRequestId}`, data);
      return res.json({ success: true, data });
    }

    const groups = presentModifierGroups(product);
    const { selected, missing } = matchOptionPicks(groups, req.body?.options);

    if (selected.some((s) => s.additionalPrice > 0)) {
      const data = {
        status: "ineligible",
        reason: "This listing has paid extras — message the vendor to order it.",
      };
      if (buyerId && clientRequestId) rememberAdd(`${buyerId}:${clientRequestId}`, data);
      return res.json({ success: true, data });
    }

    if (missing.length > 0) {
      const data = {
        status: "needs_options",
        productId: String(product._id),
        quantity,
        name: product.name,
        vendorId: String(product.vendorId),
        vendorName,
        imageUrl: product.mainImageUrl,
        unitPrice: product.price / 100,
        missing,
      };
      return res.json({ success: true, data });
    }

    const data = {
      status: "ok",
      line: {
        productId: String(product._id),
        vendorId: String(product.vendorId),
        vendorName,
        name: product.name,
        imageUrl: product.mainImageUrl,
        unitPrice: product.price / 100,
        quantity,
        options: selected.map(({ group, option }) => ({ group, option })),
      },
    };
    if (buyerId && clientRequestId) rememberAdd(`${buyerId}:${clientRequestId}`, data);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/cart/quote ─────────────────────────────────────────────────────
// Body: { items: [{ productId, quantity }] }
// Prices the cart without opening a Paystack session, so the drawer can
// show the service fee before the buyer commits.

export async function quoteCart(req, res, next) {
  try {
    const { items } = await loadCheckoutableItems(req.body?.items);
    const quote = quoteItems(items);
    res.json({
      success: true,
      data: {
        vendorId: String(items[0].product.vendorId),
        items: quote.items.map((item) => ({
          productId: String(item.productId),
          name: item.name,
          imageUrl: item.imageUrl,
          unitPriceKobo: item.unitPriceKobo,
          quantity: item.quantity,
          lineTotalKobo: item.lineTotalKobo,
        })),
        subtotalKobo: quote.subtotalKobo,
        commissionKobo: quote.commissionKobo,
        paystackFeeKobo: quote.paystackFeeKobo,
        serviceFeeKobo: quote.commissionKobo + quote.paystackFeeKobo,
        totalKobo: quote.totalKobo,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/cart/checkout ──────────────────────────────────────────────────
// Body: { items: [{ productId, quantity }], fulfillment: { name, phone, address } }
// Opens a Paystack session. Stock is NOT decremented here.

export async function checkoutCart(req, res, next) {
  try {
    const buyerId = req.buyer?.buyerId;
    if (!buyerId) throw new AppError("Not authenticated.", 401);

    const buyer = await Buyer.findById(buyerId).select("email name");
    if (!buyer) throw new AppError("Account not found.", 404);
    if (!buyer.email) {
      throw new AppError(
        "Add an email to your account before checking out — Paystack needs one for the receipt.",
        400,
      );
    }

    const fulfillment = parseFulfillment(req.body?.fulfillment);
    const { vendor, items } = await loadCheckoutableItems(req.body?.items);
    const store = await Store.findOne({ vendorId: vendor._id }).select(
      "name handle",
    );
    const quote = quoteItems(items);
    const reference = `vcart_${crypto.randomBytes(12).toString("hex")}`;
    const callbackBase = frontendBase();
    const callbackUrl = callbackBase
      ? `${callbackBase}/cart/callback`
      : undefined;

    const order = await Order.create({
      buyerId,
      vendorId: vendor._id,
      vendorName: store?.name || vendor.company?.name || vendor.name || null,
      storeHandle: store?.handle || null,
      fulfillment,
      items: quote.items,
      subtotalKobo: quote.subtotalKobo,
      commissionKobo: quote.commissionKobo,
      paystackFeeKobo: quote.paystackFeeKobo,
      totalKobo: quote.totalKobo,
      status: "pending",
      paystackReference: reference,
    });

    let result;
    try {
      result = await initializeTransaction({
        email: buyer.email,
        amount: quote.totalKobo / 100,
        reference,
        callbackUrl,
        metadata: {
          type: "cart_checkout",
          orderId: String(order._id),
          buyerId: String(buyerId),
          vendorId: String(vendor._id),
        },
        channels: ["card", "bank_transfer"],
      });
    } catch (err) {
      order.status = "cancelled";
      await order.save();
      throw new AppError(
        err instanceof Error ? err.message : "Couldn't start the payment.",
        502,
      );
    }

    const authorizationUrl = result?.authorization_url;
    if (!authorizationUrl) {
      order.status = "cancelled";
      await order.save();
      throw new AppError("Couldn't start the payment. Please try again.", 502);
    }

    res.json({
      success: true,
      data: {
        authorizationUrl,
        reference,
        order: presentOrder(order),
      },
    });
  } catch (err) {
    next(err);
  }
}

// Marks a pending order paid: decrements stock, snapshots the payout
// recipient, notifies the vendor. Idempotent on status — a second call
// (webhook + verify racing) is a no-op.
export async function markOrderPaid(order, { recipientCode }) {
  if (
    order.status === "paid" ||
    order.status === "accepted" ||
    order.status === "confirmed"
  ) {
    return order;
  }
  if (order.status !== "pending") {
    throw new AppError("This order can't be marked paid.", 409);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const item of order.items) {
        const listing = await Product.findById(item.productId)
          .select("quantity name")
          .session(session);
        if (!listing) {
          throw new AppError(
            `${item.name} sold out before the payment landed.`,
            409,
          );
        }
        // Null quantity = stock was never tracked (listings from before
        // checkout). Don't invent a count and don't fail the payment.
        if (listing.quantity == null) continue;
        const updated = await Product.findOneAndUpdate(
          {
            _id: item.productId,
            quantity: { $gte: item.quantity },
          },
          { $inc: { quantity: -item.quantity } },
          { session, new: true },
        );
        if (!updated) {
          throw new AppError(
            `${item.name} sold out before the payment landed.`,
            409,
          );
        }
      }

      order.status = "paid";
      order.settlement = "escrowed";
      order.paidAt = new Date();
      order.payoutRecipientCode = recipientCode;
      await order.save({ session });
    });
  } finally {
    await session.endSession();
  }

  notifyUser(String(order.vendorId), {
    title: "New order",
    body: `${order.items.length === 1 ? order.items[0].name : `${order.items.length} items`} · ₦${Math.round(order.subtotalKobo / 100).toLocaleString()}`,
    url: `/${order.vendorId}/orders`,
    tag: `order:${order._id}`,
    type: "new-order",
    metadata: { orderId: String(order._id) },
  }).catch((err) => {
    console.error("[cart] vendor notify failed:", err.message);
  });

  return order;
}

// Called from the Paystack webhook. Never throws — a webhook handler must
// not 500 Paystack into a retry loop.
export async function fulfillCartCharge(data) {
  try {
    const reference = data?.reference;
    if (!reference) return;
    const order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      console.error(`[cart] charge.success for unknown reference ${reference}`);
      return;
    }
    if (data.amount !== order.totalKobo) {
      console.error(
        `[cart] amount mismatch on ${reference}: paystack ${data.amount} vs order ${order.totalKobo}`,
      );
      return;
    }

    const vendor = await User.findById(order.vendorId).select("+payout");
    if (!vendor?.payout?.recipientCode) {
      console.error(
        `[cart] paid order ${order._id} has no payout recipient — holding funds`,
      );
    }

    await markOrderPaid(order, {
      recipientCode: vendor?.payout?.recipientCode ?? null,
    });
  } catch (err) {
    console.error("[cart] fulfillCartCharge failed:", err.message);
  }
}

// ── POST /api/cart/verify ────────────────────────────────────────────────────
// Body: { reference }. Same fulfill path as the webhook, so a missing
// webhook (local/dev) still marks the order paid.

export async function verifyCartCheckout(req, res, next) {
  try {
    const buyerId = req.buyer?.buyerId;
    if (!buyerId) throw new AppError("Not authenticated.", 401);

    const reference = String(req.body?.reference ?? "").trim();
    if (!reference) throw new AppError("reference is required.", 400);

    const order = await Order.findOne({ paystackReference: reference });
    if (!order) throw new AppError("Order not found.", 404);
    if (String(order.buyerId) !== String(buyerId)) {
      throw new AppError("Order not found.", 404);
    }

    if (order.status === "pending") {
      const transaction = await verifyTransaction(reference);
      if (transaction.status !== "success") {
        throw new AppError(`Payment ${transaction.status}.`, 402);
      }
      if (transaction.amount !== order.totalKobo) {
        throw new AppError("Payment amount didn't match this order.", 409);
      }
      const vendor = await User.findById(order.vendorId).select("+payout");
      await markOrderPaid(order, {
        recipientCode: vendor?.payout?.recipientCode ?? null,
      });
    }

    res.json({ success: true, data: { order: presentOrder(order) } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/cart/orders ─────────────────────────────────────────────────────

export async function listBuyerOrders(req, res, next) {
  try {
    const buyerId = req.buyer?.buyerId;
    if (!buyerId) throw new AppError("Not authenticated.", 401);

    const orders = await Order.find({
      buyerId,
      status: {
        $in: [
          "paid",
          "accepted",
          "dispatched",
          "delivered",
          "received",
          "disputed",
          "confirmed",
        ],
      },
    })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      success: true,
      data: { orders: await presentOrders(orders) },
    });
  } catch (err) {
    next(err);
  }
}

export async function getBuyerOrder(req, res, next) {
  try {
    const buyerId = req.buyer?.buyerId;
    if (!buyerId) throw new AppError("Not authenticated.", 401);

    const order = await Order.findById(req.params.id);
    if (!order || String(order.buyerId) !== String(buyerId)) {
      throw new AppError("Order not found.", 404);
    }
    const [presented] = await presentOrders([order]);
    res.json({ success: true, data: { order: presented } });
  } catch (err) {
    next(err);
  }
}

export async function markOrderReceived(req, res, next) {
  try {
    const buyerId = req.buyer?.buyerId;
    if (!buyerId) throw new AppError("Not authenticated.", 401);

    const order = await Order.findById(req.params.id);
    if (!order || String(order.buyerId) !== String(buyerId)) {
      throw new AppError("Order not found.", 404);
    }
    if (order.status !== "delivered" && order.status !== "received") {
      throw new AppError("Confirm receipt after the order is delivered.", 409);
    }
    if (order.settlement === "frozen" || order.status === "disputed") {
      throw new AppError("This order is paused while a dispute is open.", 409);
    }
    order.status = "received";
    order.receivedAt = order.receivedAt ?? new Date();
    await order.save();
    const { releaseFunds } = await import("../orders/vendorOrders.controller.js");
    await releaseFunds(order);
    res.json({ success: true, data: { order: presentOrder(order) } });
  } catch (err) {
    next(err);
  }
}

export async function disputeOrder(req, res, next) {
  try {
    const buyerId = req.buyer?.buyerId;
    if (!buyerId) throw new AppError("Not authenticated.", 401);

    const order = await Order.findById(req.params.id);
    if (!order || String(order.buyerId) !== String(buyerId)) {
      throw new AppError("Order not found.", 404);
    }
    if (order.status !== "dispatched" && order.status !== "delivered") {
      throw new AppError("A dispute can only be opened on a dispatched or delivered order.", 409);
    }

    const reason = ["not_received", "wrong_item", "damaged", "other"].includes(
      req.body?.reason,
    )
      ? req.body.reason
      : "other";

    order.status = "disputed";
    order.disputedAt = new Date();
    order.dispute = {
      reason,
      detail: typeof req.body?.detail === "string" ? req.body.detail : null,
      photoUrls: Array.isArray(req.body?.photoUrls) ? req.body.photoUrls : [],
      openedAt: new Date(),
      resolvedAt: null,
      resolution: null,
    };
    if (order.settlement === "escrowed") order.settlement = "frozen";
    await order.save();

    notifyUser(String(order.vendorId), {
      type: "new-order",
      title: "A buyer reported a problem",
      body: `${order.items[0]?.name ?? "An order"} is on hold while we look into it.`,
      url: `/${order.vendorId}/orders`,
      tag: `order-disputed:${order._id}`,
    }).catch((err) => {
      console.error("[orders] vendor dispute notify failed:", err.message);
    });

    res.json({ success: true, data: { order: presentOrder(order) } });
  } catch (err) {
    next(err);
  }
}

export { presentOrder };
