import Buyer from "../models/Buyer.model.js";
import User from "../models/Users.js";

// Resolves a price watch's owner to the contact details an alert needs,
// whichever collection they live in (2026-08-29).
//
// Buyer and User happen to share the three fields that matter here — `name`,
// `email`, `phone` — which is why the alert helper can take either without
// caring. This exists so the "which collection?" question is answered in one
// place rather than repeated at every call site that sends an alert.
//
// Returns null for an owner that no longer exists (a deleted account with a
// watch still pointing at it). Callers treat that as "no alert", not as an
// error, and the watch is left alone rather than being cleaned up here —
// deleting data from a notification path is the wrong place for it.
export async function findWatchOwner(ownerId, ownerType) {
  try {
    const model = ownerType === "vendor" ? User : Buyer;
    return await model.findById(ownerId).select("name email phone").lean();
  } catch {
    return null;
  }
}
