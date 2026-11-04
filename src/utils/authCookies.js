// Options for both session cookies (auth_token and buyer_auth_token).
//
// Staging is served cross-site from velte-dev.vercel.app exactly like
// production is from velte.ng, so it needs the same Secure + SameSite=None.
//
// A cookie is only removed when clearCookie is given the SAME attributes it
// was set with — a mismatch (different sameSite/secure, or a domain the set
// call never used) is a silent no-op that leaves the session alive. Every
// set and clear of a session cookie must go through these two functions.
export function sessionCookieOptions() {
  const isProd =
    process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  };
}

// Same attributes minus maxAge — res.clearCookie already expires the cookie,
// and passing maxAge is deprecated (ignored in Express v5).
export function clearSessionCookieOptions() {
  const options = sessionCookieOptions();
  delete options.maxAge;
  return options;
}
