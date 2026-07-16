// Write-time embedding for Velte Connect retrieval
// (Velte_Connect_Technical_Implementation.md §6) — embeds products/stores on
// save. Renamed from this file's old name, retrieval.service.js: the actual
// search/ranking logic (searchProducts, searchStores, geo tiering, wallet-
// eligibility filtering, exposure rotation) moved to the standalone
// staffly-ai-backend service so the buyer-facing search hot path doesn't
// share traffic/deploys with this dashboard API. This file keeps only the
// two functions velte-backend's own write paths (product/store
// create/update) still need — see product.controller.js, store.controller.js,
// auth.js.

import Product from "../models/Product.model.js";
import Store from "../models/Store.model.js";
import { embed, embedImage } from "./voyage.service.js";

export function productEmbeddingText(product) {
  const attrs = (product.attributes || [])
    .map((a) => `${a.name}: ${a.value}`)
    .join(", ");
  return [product.name, product.categoryId, attrs, product.description]
    .filter(Boolean)
    .join(". ");
}

export function storeEmbeddingText(store) {
  return [store.name, (store.sectors || []).join(" "), store.description]
    .filter(Boolean)
    .join(". ");
}

/**
 * Embed a product's text and (if it has one) its main image, and persist
 * both vectors. Best-effort — never throws; the two embeddings fail
 * independently so a Voyage multimodal outage doesn't also block the text
 * embedding that already worked fine.
 */
export async function embedAndSaveProduct(product) {
  const $set = {};

  try {
    const vectors = await embed([productEmbeddingText(product)], "document");
    if (vectors?.[0]) $set.embedding = vectors[0];
  } catch (err) {
    console.error("[embedding] embedAndSaveProduct text embed failed:", err.message);
  }

  if (product.mainImageUrl) {
    try {
      // Pure image, no accompanying text — must match the query side's
      // embedImage(imageUrl, "query") call (also pure image) in
      // staffly-ai-backend's searchProducts. Pairing text with only one side
      // skews that one embedding toward text-embedding-space, making cosine
      // similarity against the other, purely-visual side systematically
      // lower even for a genuine visual match.
      const imageVector = await embedImage(product.mainImageUrl, "document");
      if (imageVector) $set.imageEmbedding = imageVector;
    } catch (err) {
      console.error("[embedding] embedAndSaveProduct image embed failed:", err.message);
    }
  }

  if (Object.keys($set).length === 0) return;
  try {
    await Product.updateOne({ _id: product._id }, { $set });
  } catch (err) {
    console.error("[embedding] embedAndSaveProduct save failed:", err.message);
  }
}

/** Embed a store and persist the vector. Best-effort — never throws. */
export async function embedAndSaveStore(store) {
  try {
    const vectors = await embed([storeEmbeddingText(store)], "document");
    if (!vectors?.[0]) return;
    await Store.updateOne(
      { _id: store._id },
      { $set: { embedding: vectors[0] } },
    );
  } catch (err) {
    console.error("[embedding] embedAndSaveStore failed:", err.message);
  }
}
