import dotenv from "dotenv-flow";
dotenv.config();

import mongoose from "mongoose";
import { searchProducts } from "../services/retrieval.service.js";

// Validates the retrieval core against seed/real data without needing the
// LLM layer (build-order step c) or any UI (step d) to exist yet.
// Usage: node src/scripts/test-retrieval.js "<query>" <lat> <lng> [radiusKm]

async function run() {
  const [, , queryText, latArg, lngArg, radiusArg] = process.argv;
  if (!queryText || latArg === undefined || lngArg === undefined) {
    console.error(
      'Usage: node src/scripts/test-retrieval.js "<query>" <lat> <lng> [radiusKm]',
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const results = await searchProducts({
    queryText,
    lat: parseFloat(latArg),
    lng: parseFloat(lngArg),
    radiusKm: radiusArg ? parseFloat(radiusArg) : 10,
  });

  console.log(`\n${results.length} result(s) for "${queryText}":\n`);
  for (const r of results) {
    const priceLabel = r.priceMax ? `₦${r.price}–₦${r.priceMax}` : `₦${r.price}`;
    console.log(
      `  [score ${r.score}] ${r.name} — ${priceLabel} · ${r.vendorName} (${r.area ?? r.state ?? "?"}) · ${r.distanceKm}km`,
    );
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Test retrieval failed:", err);
  process.exit(1);
});
