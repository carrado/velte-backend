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

/**
 * Embed one or more texts. `inputType` should be "document" when embedding
 * catalog data (products/stores) and "query" when embedding a buyer's search
 * text — Voyage tunes the embedding differently for each side of the match.
 * Returns null (not a throw) if the key is missing or the call fails.
 */
export async function embed(texts, inputType) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !texts?.length) return null;

  try {
    const res = await fetch(VOYAGE_EMBEDDINGS_URL, {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

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
 * text-only matching if this returns null.
 */
export async function embedImage(imageUrl, inputType, text) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !imageUrl) return null;

  try {
    const content = [];
    if (text) content.push({ type: "text", text });
    content.push({ type: "image_url", image_url: imageUrl });

    const res = await fetch(VOYAGE_MULTIMODAL_URL, {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

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
 */
export async function rerank(query, documents) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !documents?.length) return null;

  try {
    const res = await fetch(VOYAGE_RERANK_URL, {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[voyage] rerank failed: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    const results = data?.results;
    if (!Array.isArray(results)) return null;

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
