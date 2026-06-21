import { v2 as cloudinary } from "cloudinary";

// Cloudinary auto-reads CLOUDINARY_URL from env. Support discrete vars too.
if (!process.env.CLOUDINARY_URL && process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

export function isCloudinaryConfigured() {
  return !!(
    process.env.CLOUDINARY_URL ||
    (process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET)
  );
}

/**
 * Upload a PDF buffer to Cloudinary as a raw asset and return its secure URL.
 * `publicId` makes regenerated documents overwrite the previous version.
 */
export function uploadPdf(buffer, { folder = "velte/documents", publicId } = {}) {
  if (!isCloudinaryConfigured()) {
    return Promise.reject(
      new Error("Cloudinary is not configured (set CLOUDINARY_URL)"),
    );
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        folder,
        public_id: publicId,
        format: "pdf",
        overwrite: true,
        invalidate: true,
      },
      (err, result) => (err ? reject(err) : resolve(result.secure_url)),
    );
    stream.end(buffer);
  });
}
