import express from "express";
import { resolveActor } from "../middleware/resolveActor.js";
import {
  createWatch,
  listDue,
  listWatches,
  removeWatch,
  reportChecks,
} from "../controllers/priceWatch/priceWatch.controller.js";

const router = express.Router();

// The checker endpoints are machine-to-machine: Velte's own frontend cron
// route calls them, and there is no buyer session on that request. Guarded
// by a shared secret instead.
//
// Why the work is split across repos at all: re-reading an external
// listing's price means parsing a Jumia/Konga/Jiji page, and that code
// already exists and is proven in the frontend (connectors/pageMeta.ts). It
// is not worth a second implementation here that would drift from the one
// that put the price on the card in the first place. So the frontend does
// the fetching and this repo owns the data and the decisions.
function verifyCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  // Fails CLOSED, unlike the buyer metering: an unset secret here would
  // leave watch data and a mail-sending endpoint open to anyone who found
  // the URL. Better that the cron silently does nothing until it is
  // configured than that this is world-callable.
  if (!expected) {
    return res
      .status(503)
      .json({ success: false, message: "Checker not configured." });
  }
  const provided = req.get("x-cron-secret");
  if (provided !== expected) {
    return res.status(401).json({ success: false, message: "Unauthorised." });
  }
  return next();
}

router.get("/due", verifyCronSecret, listDue);
router.post("/report", verifyCronSecret, reportChecks);

// Everything below is an account managing its own watches — buyer OR
// vendor. resolveActor rather than verifyBuyerAuth: vendors watch
// competitors' prices, and the buyer-only guard would have shut them out of
// their own feature the same way it did with search metering.
router.use(resolveActor);

router.get("/", listWatches);
router.post("/", createWatch);
router.delete("/:id", removeWatch);

export default router;
