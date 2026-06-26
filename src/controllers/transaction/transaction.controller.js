import mongoose from "mongoose";
import Transaction from "../../models/Transactions.model.js";
import PaymentLink from "../../models/Paymentlink.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { setSubaccountActive } from "../../services/paystack.service.js";
import crypto from "crypto";

/** Signed percentage-change string, e.g. "12.5%", "-8%", "0%". */
function pctChange(current, previous) {
  if (!previous) return current > 0 ? "100%" : "0%";
  const v = ((current - previous) / previous) * 100;
  const rounded = Math.round(v * 10) / 10;
  return `${rounded < 0 ? "-" : ""}${Math.abs(rounded)}%`;
}

function formatPaymentLink(link) {
  return {
    id: link._id.toString(),
    url: link.url,
    bankCode: link.bankCode,
    bankName: link.bankName,
    accountNumber: link.accountNumber,
    accountName: link.accountName,
    amount: link.amount,
    description: link.description,
    isActive: link.isActive,
    createdAt: link.createdAt,
  };
}

async function getOwnedPaymentLink(userId, linkId) {
  const link = await PaymentLink.findOne({
    _id: linkId,
    userId,
    deletedAt: null,
  });

  if (!link) {
    throw new AppError("Payment link not found", 404);
  }

  return link;
}

async function syncPaystackSubaccount(link, active) {
  const code = link.subaccountCode || link.paystackSubaccountId;
  if (!code) {
    throw new AppError(
      "Payment link is missing Paystack subaccount details",
      422,
    );
  }

  await setSubaccountActive(code, active);
}

let banksCache = null;
let banksCachedAt = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export const getBanks = async (req, res, next) => {
  try {
    const now = Date.now();
    if (banksCache && banksCachedAt && now - banksCachedAt < CACHE_TTL_MS) {
      return res.json({ success: true, data: banksCache });
    }

    const response = await fetch(
      "https://api.paystack.co/bank?country=nigeria&use_cursor=false&perPage=100",
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      },
    );

    if (!response.ok) throw new Error(`Paystack error: ${response.status}`);
    const result = await response.json();
    if (!result.status)
      throw new Error(result.message || "Paystack fetch failed");

    banksCache = result.data.map(({ code, name }) => ({ code, name }));
    banksCachedAt = now;

    res.json({ success: true, data: banksCache });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/transactions/resolve-account ─────────────────────────────────────
// Query params: accountNumber, bankCode
export const resolveAccount = async (req, res, next) => {
  try {
    const { accountNumber, bankCode } = req.query;

    if (!accountNumber || !bankCode) {
      throw new AppError("accountNumber and bankCode are required", 400);
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      throw new AppError("accountNumber must be exactly 10 digits", 400);
    }

    const bank = banksCache.find((b) => b.code === bankCode);
    if (!bank) {
      throw new AppError("Invalid bank code", 400);
    }

    // ── Paystack account resolution ──
    const paystackRes = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      },
    );

    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status) {
      throw new AppError(
        paystackData.message || "Could not resolve account",
        422,
      );
    }

    res.json({
      success: true,
      data: {
        accountName: paystackData.data.account_name,
        accountNumber: paystackData.data.account_number,
        bankCode,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/transactions/payment-link ───────────────────────────────────────
export const generatePaymentLink = async (req, res, next) => {
  try {
    const { bankCode, accountNumber, accountName } = req.body;

    if (!bankCode || !accountNumber || !accountName) {
      throw new AppError(
        "bankCode, accountNumber, and accountName are required",
        400,
      );
    }

    const bank = banksCache?.find((b) => b.code === bankCode);
    if (!bank) throw new AppError("Invalid bank code", 400);

    // Save the vendor's bank account. No Paystack subaccount or hosted payment
    // link is created: customers pay by DIRECT bank transfer, and staffly shares
    // these details on WhatsApp at checkout (verified later via uploaded receipt).
    // NOTE: `linkId`/`url` are kept (the model still requires them and old links
    // remain readable) but are vestigial for this flow — they're removed in the
    // payment-link teardown step. The record is stored in the shared collection
    // staffly already reads by userId.
    const linkId = crypto.randomBytes(8).toString("hex");
    const baseUrl = process.env.FRONTEND_URL || "https://velte.ng";

    const bankAccount = await PaymentLink.create({
      userId: req.user.userId,
      linkId,
      url: `${baseUrl}/pay/${linkId}`,
      bankCode,
      bankName: bank.name,
      accountNumber,
      accountName,
      amount: null,
      description: "",
    });

    res.status(201).json({
      success: true,
      data: bankAccount.toJSON(),
      message: "Bank account saved successfully",
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/transactions ─────────────────────────────────────────────────────
export const getTransactions = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      paymentMethod,
      startDate,
      endDate,
    } = req.query;

    const userId = req.user.userId;
    const filter = { userId };

    if (status) filter.status = status;
    if (paymentMethod) filter.method = paymentMethod;

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { customerId: { $regex: search, $options: "i" } },
      ];
    }

    const allowedSortFields = ["createdAt", "total", "date", "status"];
    const safeSortBy = allowedSortFields.includes(sortBy)
      ? sortBy
      : "createdAt";
    const safeSortOrder = sortOrder === "asc" ? 1 : -1;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [transactions, total, latestPaymentLink] = await Promise.all([
      Transaction.find(filter)
        .sort({ [safeSortBy]: safeSortOrder })
        .skip(skip)
        .limit(limitNum)
        .lean({ transform: true }),
      Transaction.countDocuments(filter),
      PaymentLink.findOne({ userId, deletedAt: null }, null, {
        sort: { createdAt: -1 },
      }).lean(),
    ]);

    // Stats — headline totals are all-time; the change % is this 7 days vs the
    // previous 7 days. Cast userId to ObjectId: aggregate() does NOT auto-cast,
    // so matching the raw JWT string would silently match nothing.
    const uid = new mongoose.Types.ObjectId(userId);
    const now = new Date();
    const last7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prev7 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const revenueExpr = {
      $sum: { $cond: [{ $eq: ["$status", "Complete"] }, "$total", 0] },
    };
    const countExpr = (s) => ({
      $sum: { $cond: [{ $eq: ["$status", s] }, 1, 0] },
    });
    const groupSpec = {
      _id: null,
      revenue: revenueExpr,
      completed: countExpr("Complete"),
      pending: countExpr("Pending"),
      failed: countExpr("Canceled"),
    };

    const [agg] = await Transaction.aggregate([
      { $match: { userId: uid } },
      {
        $facet: {
          allTime: [{ $group: groupSpec }],
          current: [
            { $match: { createdAt: { $gte: last7 } } },
            { $group: groupSpec },
          ],
          previous: [
            { $match: { createdAt: { $gte: prev7, $lt: last7 } } },
            { $group: groupSpec },
          ],
        },
      },
    ]);

    const zero = { revenue: 0, completed: 0, pending: 0, failed: 0 };
    const allTime = agg?.allTime?.[0] ?? zero;
    const cur = agg?.current?.[0] ?? zero;
    const prev = agg?.previous?.[0] ?? zero;

    const stats = {
      totalRevenue: `₦${Number(allTime.revenue).toLocaleString()}`,
      completedTransactions: allTime.completed,
      pendingTransactions: allTime.pending,
      failedTransactions: allTime.failed,
      revenueChange: pctChange(cur.revenue, prev.revenue),
      completedChange: pctChange(cur.completed, prev.completed),
      pendingChange: pctChange(cur.pending, prev.pending),
      failedChange: pctChange(cur.failed, prev.failed),
    };

    // Transform lean docs to match frontend shape. `orderId` is the originating
    // order's DB id (for the "View details" link); prefer the explicit
    // orderObjectId, falling back to the legacy metadata.orderId.
    const formatted = transactions.map((t) => ({
      id: t._id.toString(),
      customerId: t.customerId,
      name: t.name,
      date: t.date,
      total: `₦${Number(t.total).toLocaleString()}`,
      method: t.method,
      status: t.status,
      orderId: t.metadata?.orderObjectId ?? t.metadata?.orderId ?? null,
    }));

    res.json({
      success: true,
      data: {
        transactions: formatted,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
        stats,
        paymentLink: latestPaymentLink
          ? formatPaymentLink(latestPaymentLink)
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/transactions/payment-link/:id/deactivate ───────────────────────
export const deactivatePaymentLink = async (req, res, next) => {
  try {
    const link = await getOwnedPaymentLink(req.user.userId, req.params.id);

    if (!link.isActive) {
      throw new AppError("Payment link is already inactive", 400);
    }

    await syncPaystackSubaccount(link, false);

    link.isActive = false;
    await link.save();

    res.json({
      success: true,
      data: formatPaymentLink(link),
      message: "Payment link deactivated",
    });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/transactions/payment-link/:id/reactivate ───────────────────────
export const reactivatePaymentLink = async (req, res, next) => {
  try {
    const link = await getOwnedPaymentLink(req.user.userId, req.params.id);

    if (link.isActive) {
      throw new AppError("Payment link is already active", 400);
    }

    await syncPaystackSubaccount(link, true);

    link.isActive = true;
    await link.save();

    res.json({
      success: true,
      data: formatPaymentLink(link),
      message: "Payment link reactivated",
    });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/transactions/payment-link/:id ─────────────────────────────────
export const deletePaymentLink = async (req, res, next) => {
  try {
    const link = await getOwnedPaymentLink(req.user.userId, req.params.id);

    if (link.isActive) {
      await syncPaystackSubaccount(link, false);
    }

    link.isActive = false;
    link.deletedAt = new Date();
    await link.save();

    res.json({
      success: true,
      message: "Payment link deleted",
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/transactions ────────────────────────────────────────────────────
export const createTransaction = async (req, res, next) => {
  try {
    const { customerId, name, date, total, method, status, reference } =
      req.body;

    if (!customerId || !name || !total || !method) {
      throw new AppError(
        "customerId, name, total, and method are required",
        400,
      );
    }

    const tx = await Transaction.create({
      userId: req.user.userId,
      customerId,
      name,
      date: date || new Date().toLocaleDateString("en-GB").replace(/\//g, "-"),
      total: parseFloat(String(total).replace(/[^0-9.]/g, "")),
      method,
      status: status || "Pending",
      reference: reference || undefined,
    });

    res.status(201).json({
      success: true,
      data: tx.toJSON(),
      message: "Transaction created",
    });
  } catch (err) {
    next(err);
  }
};
