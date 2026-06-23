import Customer from "../../models/Customer.model.js";

// ── GET /api/customers ────────────────────────────────────────────────────────
// Every customer of the authenticated business, newest first. The customers UI
// fetches the full list and filters/sorts client-side, so no server-side paging
// is needed here. Records are created/updated by recordSale() when an order is paid.
export const getCustomers = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const customers = await Customer.find({ userId })
      .sort({ createdAt: -1 })
      .lean();

    // Shape each record to exactly what the customers UI expects.
    const data = customers.map((c) => ({
      id: c._id.toString(),
      name: c.name || "Customer",
      phone: c.phone || "",
      email: c.email || "",
      orders: c.orders || 0,
      spend: Number(c.totalSpend || 0).toLocaleString("en-NG", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      status: c.status || "Active",
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/customers/stats ──────────────────────────────────────────────────
// New-customers-per-day for this week and last week (Sun→Sat), for the customer
// overview chart. A "new customer" is one whose record was created (first paid
// order) on that day. Weeks start on Sunday in server-local time, consistent with
// the rest of the app's date handling.
export const getCustomerStats = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const startThisWeek = new Date(startOfToday);
    startThisWeek.setDate(startOfToday.getDate() - startOfToday.getDay()); // back to Sunday
    const startLastWeek = new Date(startThisWeek);
    startLastWeek.setDate(startThisWeek.getDate() - 7);
    const startNextWeek = new Date(startThisWeek);
    startNextWeek.setDate(startThisWeek.getDate() + 7);

    const recent = await Customer.find({
      userId,
      createdAt: { $gte: startLastWeek, $lt: startNextWeek },
    })
      .select("createdAt")
      .lean();

    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const thisWeek = DAYS.map((day) => ({ day, value: 0 }));
    const lastWeek = DAYS.map((day) => ({ day, value: 0 }));

    for (const c of recent) {
      const d = new Date(c.createdAt);
      const bucket = d >= startThisWeek ? thisWeek : lastWeek;
      bucket[d.getDay()].value += 1;
    }

    res.json({ success: true, data: { thisWeek, lastWeek } });
  } catch (err) {
    next(err);
  }
};
