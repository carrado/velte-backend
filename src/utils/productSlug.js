import Product from "../models/Product.model.js";

/** URL slug from a listing name — lowercase, hyphenated, no edge hyphens. */
export function slugifyProductName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}

/** Stable unique slug: `{name-slug}-{last6OfId}`. Id suffix avoids collisions
 *  without a uniqueness scan on every create. */
export function productSlugFor(name, productId) {
  const base = slugifyProductName(name) || "listing";
  const suffix = String(productId).slice(-6).toLowerCase();
  return `${base}-${suffix}`;
}

/** Persist a slug when missing (legacy rows). Returns the slug. */
export async function ensureProductSlug(product) {
  if (product?.slug) return product.slug;
  if (!product?._id) return null;
  const slug = productSlugFor(product.name, product._id);
  await Product.updateOne(
    {
      _id: product._id,
      $or: [{ slug: null }, { slug: { $exists: false } }, { slug: "" }],
    },
    { $set: { slug } },
  );
  product.slug = slug;
  return slug;
}
