import crypto from "crypto";

/**
 * Verify an inbound staffly → velte internal request. Staffly signs the RAW body
 * with the shared VELTE_WEBHOOK_SECRET (HMAC-SHA256) and sends:
 *   x-staffly-signature: sha256=<hex digest>
 * (mirrors velte's own dispatchToStaffly, reverse direction). The route must mount
 * express.raw upstream so req.body is the exact bytes that were signed. On success
 * the parsed JSON is attached as req.stafflyBody.
 */
export function verifyStafflySignature(req, res, next) {
  const secret = process.env.VELTE_WEBHOOK_SECRET;
  if (!secret) {
    return res
      .status(500)
      .json({
        success: false,
        error: "Server not configured for staffly bridge",
      });
  }

  const signature = req.headers["x-staffly-signature"];
  if (!signature) {
    return res.status(401).json({ success: false, error: "Missing signature" });
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, error: "Invalid signature" });
  }

  try {
    req.stafflyBody = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, error: "Invalid JSON body" });
  }
  next();
}
