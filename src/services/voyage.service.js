// Voyage AI client — embeddings + reranking for Velte Connect retrieval
// (Velte_Connect_Technical_Implementation.md §6). Plain fetch, no SDK, same
// style as the Groq integration in the frontend's generateBusinessDescription:
// hard timeout, never throw — callers degrade gracefully (skip embedding /
// fall back to vector-search order) rather than fail the caller's request.

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";
const VOYAGE_MULTIMODAL_URL = "https://api.voyageai.com/v1/multimodalembeddings";
const EMBED_MODEL = "voyage-4";
const RERANK_MODEL = "rerank-2.5";
const MULTIMODAL_MODEL = "voyage-multimodal-3";
const TIMEOUT_MS = 15_000;

// Found live: an otherwise-correct search (identical photo, real catalog
// match) came back empty because a single Voyage call had a transient
// hiccup — a slow response or a momentary 5xx/429 — with no retry, silently
// degrading that one buyer's turn to whatever weaker fallback the caller has
// (raw cosine score instead of rerank, or vector-search order alone instead
// of a real embedding).
//
// Just 1 retry (2 attempts total), not more: this app runs on a serverless
// host with a function-duration ceiling (Vercel), and a single search can
// already fan out to several of these calls in one request (embed + up to 3
// geo-tier rerank calls in searchProducts, doubled again if a zero-result
// turn falls through to searchStores). More retries per call compounds that
// fan-out multiplicatively — found live that 2 retries × TIMEOUT_MS put a
// pathological worst case (every call needs every retry) around 400s for one
// buyer turn, far past any realistic function timeout. `deadlineAt` (passed
// by retrieval.service.js, shared across every Voyage call within one
// searchProducts/searchStores invocation) bounds the pathological case
// further still — see its call sites for the actual budget.
const MAX_RETRIES = 1;
const RETRY_DELAYS_MS = [250];

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `makeRequest` (a thunk taking this attempt's timeout in ms, not a
 * promise — each attempt needs its own fresh AbortSignal.timeout, since a
 * shared one would already be counting down from the first attempt) on a
 * retryable HTTP status or a network-level throw (timeout, DNS, connection
 * reset). Never retries a non-retryable status (4xx other than 429) — that's
 * a real request problem a retry can't fix. Re-throws the last error after
 * the final attempt; callers already catch around their fetch call, so this
 * doesn't change their never-throw contract, just how many attempts happen
 * before they see a failure.
 *
 * `deadlineAt` (a Date.now()-scale timestamp, optional) caps both the
 * per-attempt timeout and whether a retry is even attempted — once the
 * shared search-level budget a caller passed in is spent, this gives up
 * immediately rather than starting an attempt it can't finish anyway.
 * `undefined` (e.g. background embedAndSaveProduct/embedAndSaveStore, not
 * part of a live buyer request) means "no external budget", just TIMEOUT_MS.
 */
async function fetchWithRetry(makeRequest, label, deadlineAt) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const remainingMs =
      deadlineAt == null ? TIMEOUT_MS : deadlineAt - Date.now();
    if (remainingMs <= 0) {
      console.error(`[voyage] ${label} skipped — search deadline already spent`);
      throw lastErr ?? new Error(`${label}: search deadline exceeded`);
    }

    try {
      const res = await makeRequest(Math.min(TIMEOUT_MS, remainingMs));
      if (res.ok || !isRetryableStatus(res.status) || attempt === MAX_RETRIES) {
        return res;
      }
      console.error(
        `[voyage] ${label} got ${res.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES})…`,
      );
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      lastErr = err;
      console.error(
        `[voyage] ${label} network error, retrying (attempt ${attempt + 1}/${MAX_RETRIES}):`,
        err.message,
      );
    }

    const backoff = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1);
    const budgetLeft =
      deadlineAt == null ? backoff : Math.max(0, deadlineAt - Date.now());
    await sleep(Math.min(backoff, budgetLeft));
  }
  throw lastErr;
}

/**
 * Embed one or more texts. `inputType` should be "document" when embedding
 * catalog data (products/stores) and "query" when embedding a buyer's search
 * text — Voyage tunes the embedding differently for each side of the match.
 * Returns null (not a throw) if the key is missing or the call fails.
 *
 * `deadlineAt` — optional Date.now()-scale timestamp shared across every
 * Voyage call within one buyer search (see retrieval.service.js) — bounds
 * this call's own timeout/retry budget. Omitted for background calls that
 * aren't part of a live buyer request (embedAndSaveProduct/embedAndSaveStore
 * below).
 */
export async function embed(texts, inputType, deadlineAt) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !texts?.length) return null;

  try {
    const res = await fetchWithRetry(
      (timeoutMs) =>
        fetch(VOYAGE_EMBEDDINGS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: EMBED_MODEL,
            input: texts,
            input_type: inputType,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      "embed",
      deadlineAt,
    );

    if (!res.ok) {
      console.error(`[voyage] embed failed: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    const vectors = data?.data?.map((d) => d.embedding);
    return Array.isArray(vectors) && vectors.every(Array.isArray)
      ? vectors
      : null;
  } catch (err) {
    console.error("[voyage] embed error:", err.message);
    return null;
  }
}

/**
 * Embed a single image (optionally paired with text) via voyage-multimodal-3
 * — this is what makes a photo search compare against an actual visual
 * embedding of a product's image, rather than only the LLM's text paraphrase
 * of the photo matched against text-only product embeddings. Voyage accepts
 * a plain HTTPS `image_url` directly (no need to fetch/base64 it ourselves).
 * Same never-throw convention as `embed`/`rerank` — callers fall back to
 * text-only matching if this returns null. `deadlineAt` — see `embed`'s doc
 * comment above.
 */
export async function embedImage(imageUrl, inputType, text, deadlineAt) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !imageUrl) return null;

  try {
    const content = [];
    if (text) content.push({ type: "text", text });
    content.push({ type: "image_url", image_url: imageUrl });

    const res = await fetchWithRetry(
      (timeoutMs) =>
        fetch(VOYAGE_MULTIMODAL_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MULTIMODAL_MODEL,
            inputs: [{ content }],
            input_type: inputType,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      "embedImage",
      deadlineAt,
    );

    if (!res.ok) {
      console.error(
        `[voyage] embedImage failed: ${res.status} ${await res.text()}`,
      );
      return null;
    }

    const data = await res.json();
    const vector = data?.data?.[0]?.embedding;
    return Array.isArray(vector) ? vector : null;
  } catch (err) {
    console.error("[voyage] embedImage error:", err.message);
    return null;
  }
}

/**
 * Rerank `documents` against `query`, returning a relevance score per
 * document in the SAME order as the input array (not sorted). Returns null
 * on any failure so callers can fall back to vector-search order alone.
 * `deadlineAt` — see `embed`'s doc comment above.
 */
export async function rerank(query, documents, deadlineAt) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !documents?.length) return null;

  try {
    const res = await fetchWithRetry(
      (timeoutMs) =>
        fetch(VOYAGE_RERANK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: RERANK_MODEL,
            query,
            documents,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      "rerank",
      deadlineAt,
    );

    if (!res.ok) {
      console.error(`[voyage] rerank failed: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    // Voyage's rerank envelope is { object, data: [{index, relevance_score}],
    // model, usage } — NOT { results: [...] }. This field name was wrong from
    // the start, so rerank() silently returned null on every single call
    // (Array.isArray(undefined) === false), meaning every search has always
    // fallen back to the raw cosine-similarity floor (RAW_SCORE_FLOOR /
    // STORE_RAW_SCORE_FLOOR) instead of the calibrated RERANK_FLOOR path —
    // found live while investigating an irrelevant vendor match. That raw
    // floor is a much cruder signal (see retrieval.service.js's own comment
    // on why raw cosine similarity runs high even for unrelated items in a
    // small catalog), so this was silently degrading match quality on every
    // search, not just on genuine Voyage outages.
    const results = data?.data;
    if (!Array.isArray(results)) {
      console.error("[voyage] rerank response missing data[] array:", JSON.stringify(data));
      return null;
    }

    const scores = new Array(documents.length).fill(0);
    for (const r of results) {
      if (typeof r.index === "number" && typeof r.relevance_score === "number") {
        scores[r.index] = r.relevance_score;
      }
    }
    return scores;
  } catch (err) {
    console.error("[voyage] rerank error:", err.message);
    return null;
  }
}
