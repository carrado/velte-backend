import mongoose from "mongoose";

// Live-resolved short links minted by tools OUTSIDE this repo's own build —
// currently just velte-super-admin's Nudge Campaign page — as opposed to
// velte (frontend)'s own /s/[code] codes, which are baked into a static
// JSON at Next.js BUILD time (src/data/vendor-signup-shortlinks.json) and
// need a commit + redeploy before a new one resolves. An admin editing and
// sending a message live from the super-admin can't wait on a frontend
// deploy, so those tools mint a code here instead — resolved at request
// time via GET /api/shortlinks/:code (see that controller) — and velte's
// own /s/[code] route checks the static JSON first, falling back to this
// endpoint for anything it doesn't recognize. See getShortLink.
const shortLinkSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    url: { type: String, required: true },
  },
  { timestamps: true },
);

export default mongoose.model("ShortLink", shortLinkSchema);
