import dotenv from "dotenv-flow";
dotenv.config();

import mongoose from "mongoose";
import Product from "../models/Product.model.js";
import Store from "../models/Store.model.js";
import { embed, embedImage } from "../services/voyage.service.js";
import {
  productEmbeddingText,
  storeEmbeddingText,
} from "../services/retrieval.service.js";

// One-off: backfills `embedding` for Product/Store docs that predate the
// embed-on-save hooks (i.e. every real vendor/product created before this
// change). Batches calls to Voyage rather than one request per document.
const BATCH_SIZE = 20;

// Image embeds go one at a time, paced and retried — an account with no
// Voyage billing method on file is capped at 3 requests/minute (found live:
// a concurrency of 5 immediately drew 429s). 21s between calls keeps us
// under that even with zero slack; bump PACE_MS down once billing is added
// and the standard rate limit applies.
const IMAGE_PACE_MS = 21_000;
const IMAGE_MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedImageWithRetry(imageUrl) {
  for (let attempt = 1; attempt <= IMAGE_MAX_RETRIES; attempt++) {
    // Pure image, no text — must match embedAndSaveProduct's call shape so
    // document and query embeddings stay comparable (see retrieval.service.js).
    const vector = await embedImage(imageUrl, "document");
    if (vector) return vector;
    if (attempt < IMAGE_MAX_RETRIES) {
      console.log(`  … retrying in ${IMAGE_PACE_MS / 1000}s (attempt ${attempt + 1}/${IMAGE_MAX_RETRIES})`);
      await sleep(IMAGE_PACE_MS);
    }
  }
  return null;
}

async function backfillProducts() {
  const products = await Product.find({ embedding: { $exists: false } });
  console.log(`Products missing embeddings: ${products.length}`);

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    const vectors = await embed(batch.map(productEmbeddingText), "document");
    if (!vectors) {
      console.error(
        "Voyage embed failed for a product batch — aborting (check VOYAGE_API_KEY).",
      );
      return;
    }
    await Promise.all(
      batch.map((p, j) =>
        Product.updateOne({ _id: p._id }, { $set: { embedding: vectors[j] } }),
      ),
    );
    console.log(
      `  ✓ embedded ${Math.min(i + BATCH_SIZE, products.length)}/${products.length} products`,
    );
  }
}

async function backfillStores() {
  const stores = await Store.find({ embedding: { $exists: false } });
  console.log(`Stores missing embeddings: ${stores.length}`);

  for (let i = 0; i < stores.length; i += BATCH_SIZE) {
    const batch = stores.slice(i, i + BATCH_SIZE);
    const vectors = await embed(batch.map(storeEmbeddingText), "document");
    if (!vectors) {
      console.error(
        "Voyage embed failed for a store batch — aborting (check VOYAGE_API_KEY).",
      );
      return;
    }
    await Promise.all(
      batch.map((s, j) =>
        Store.updateOne({ _id: s._id }, { $set: { embedding: vectors[j] } }),
      ),
    );
    console.log(
      `  ✓ embedded ${Math.min(i + BATCH_SIZE, stores.length)}/${stores.length} stores`,
    );
  }
}

async function backfillProductImages() {
  const products = await Product.find({
    imageEmbedding: { $exists: false },
    mainImageUrl: { $ne: null },
  });
  console.log(`Products missing image embeddings: ${products.length}`);

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const vector = await embedImageWithRetry(p.mainImageUrl);
    if (!vector) {
      console.error(
        `  ✗ image embed failed for product ${p._id} (${p.name}) after ${IMAGE_MAX_RETRIES} attempts`,
      );
    } else {
      await Product.updateOne(
        { _id: p._id },
        { $set: { imageEmbedding: vector } },
      );
      console.log(`  ✓ embedded image ${i + 1}/${products.length} (${p.name})`);
    }
    if (i < products.length - 1) await sleep(IMAGE_PACE_MS);
  }
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  await backfillProducts();
  await backfillStores();
  await backfillProductImages();

  await mongoose.disconnect();
  console.log("Backfill complete.");
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
