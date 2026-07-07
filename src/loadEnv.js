// Must be the very first thing app.js imports, and nothing else. ES modules
// evaluate ALL of an importing file's static imports before ANY of that
// file's own top-level statements run — regardless of source-line order.
// app.js used to write `import dotenv...; dotenv.config();` before its other
// imports, which LOOKS like it runs first but doesn't: every later import
// (e.g. pushNotification.service.js, which reads process.env.VAPID_* at
// module-load time) was actually being evaluated before dotenv.config() ever
// ran, so those reads always saw undefined regardless of what .env held —
// confirmed live, this is why web-push was silently never enabled. Isolating
// the config() call in its own module and importing THAT first (as app.js's
// literal first import, with no other statement ahead of it) forces it to
// finish before Node moves on to any subsequent import.
import dotenv from "dotenv-flow";

dotenv.config();
