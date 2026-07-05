import dotenv from "dotenv-flow";
dotenv.config();

import mongoose from "mongoose";
import Product from "../models/Product.model.js";
import Store from "../models/Store.model.js";
import { embed } from "../services/voyage.service.js";
import {
  productEmbeddingText,
  storeEmbeddingText,
} from "../services/retrieval.service.js";

// One-off: backfills `embedding` for Product/Store docs that predate the
// embed-on-save hooks (i.e. every real vendor/product created before this
// change). Batches calls to Voyage rather than one request per document.
const BATCH_SIZE = 20;

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

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  await backfillProducts();
  await backfillStores();

  await mongoose.disconnect();
  console.log("Backfill complete.");
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
