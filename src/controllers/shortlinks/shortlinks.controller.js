import ShortLink from "../../models/ShortLink.model.js";
import { AppError } from "../../middleware/errorHandler.js";

// Public — no auth. Mirrors store.controller.js's getProductImage: resolved
// live by an opaque code, never a client-supplied URL, so this can't be
// turned into an open redirect — the only possible destinations are
// whatever a trusted internal tool already wrote into this collection
// itself (currently: velte-super-admin's Nudge Campaign page).
export async function getShortLink(req, res, next) {
  try {
    const link = await ShortLink.findOne({ code: req.params.code }).select("url");
    if (!link) throw new AppError("Short link not found.", 404);
    res.json({ success: true, data: { url: link.url } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
