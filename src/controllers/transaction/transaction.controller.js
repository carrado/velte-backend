import Transaction from "../../models/Transactions.model.js";
import PaymentLink from "../../models/Paymentlink.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { setSubaccountActive } from "../../services/paystack.service.js";
import crypto from "crypto";

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
    throw new AppError("Payment link is missing Paystack subaccount details", 422);
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
    // Replace PAYSTACK_SECRET_KEY with your env var.
    const paystackRes = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${'001'}`,
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
    const { bankCode, accountNumber, accountName, amount, description } = req.body;

    if (!bankCode || !accountNumber || !accountName) {
      throw new AppError("bankCode, accountNumber, and accountName are required", 400);
    }

    const bank = banksCache?.find((b) => b.code === bankCode);
    if (!bank) throw new AppError("Invalid bank code", 400);

    // ── 1. Create Paystack subaccount ──────────────────────────────────────
    const paystackRes = await fetch("https://api.paystack.co/subaccount", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        business_name: accountName,
        bank_code: bankCode,
        account_number: accountNumber,
        percentage_charge: 0, // 0 = all funds go to the subaccount
        description: description || `Payment link for ${accountName}`,
      }),
    });

    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status) {
      throw new AppError(
        paystackData.message || "Failed to create Paystack subaccount",
        422,
      );
    }

    const { subaccount_code, id: paystackSubaccountId } = paystackData.data;

    // ── 2. Generate link ───────────────────────────────────────────────────
    const linkId = crypto.randomBytes(8).toString("hex");
    const baseUrl = process.env.FRONTEND_URL || "https://velte.ng";
    const url = `${baseUrl}/pay/${linkId}`;

    const paymentLink = await PaymentLink.create({
      userId: req.user.userId,
      linkId,
      url,
      bankCode,
      bankName: bank.name,
      accountNumber,
      accountName,
      amount: amount || null,
      description: description || "",
      subaccountCode: subaccount_code,         // store for charging later
      paystackSubaccountId: String(paystackSubaccountId),
    });

    res.status(201).json({
      success: true,
      data: paymentLink.toJSON(),
      message: "Payment link generated successfully",
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
      PaymentLink.findOne(
        { userId, deletedAt: null },
        null,
        { sort: { createdAt: -1 } },
      ).lean(),
    ]);

    // Stats (always scoped to the user, not filtered)
    const [statsAgg] = await Transaction.aggregate([
      { $match: { userId: userId } },
      {
        $group: {
          _id: null,
          totalRevenue: {
            $sum: {
              $cond: [{ $eq: ["$status", "Complete"] }, "$total", 0],
            },
          },
          completedTransactions: {
            $sum: { $cond: [{ $eq: ["$status", "Complete"] }, 1, 0] },
          },
          pendingTransactions: {
            $sum: { $cond: [{ $eq: ["$status", "Pending"] }, 1, 0] },
          },
          failedTransactions: {
            $sum: { $cond: [{ $eq: ["$status", "Canceled"] }, 1, 0] },
          },
        },
      },
    ]);

    const stats = statsAgg
      ? {
          totalRevenue: `$${Number(statsAgg.totalRevenue).toLocaleString()}`,
          completedTransactions: statsAgg.completedTransactions,
          pendingTransactions: statsAgg.pendingTransactions,
          failedTransactions: statsAgg.failedTransactions,
          revenueChange: "14.4%", // TODO: compute from previous period
          completedChange: "20%",
          pendingChange: "85%",
          failedChange: "15%",
        }
      : {
          totalRevenue: "$0",
          completedTransactions: 0,
          pendingTransactions: 0,
          failedTransactions: 0,
          revenueChange: "0%",
          completedChange: "0%",
          pendingChange: "0%",
          failedChange: "0%",
        };

    // Transform lean docs to match frontend shape
    const formatted = transactions.map((t) => ({
      id: t._id.toString(),
      customerId: t.customerId,
      name: t.name,
      date: t.date,
      total: `$${Number(t.total).toLocaleString()}`,
      method: t.method,
      status: t.status,
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
