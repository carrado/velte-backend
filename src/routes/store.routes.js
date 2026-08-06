import express from "express";
import { verifyAuth } from "../middleware/auth.js";
import {
  getMyStore,
  updateMyStore,
  connectCatalog,
  getPublicStore,
  getStoreByVendorId,
  getMarketplacePreview,
  getVendorsPreview,
  getProductImage,
  listStoreHandlesForSitemap,
} from "../controllers/store/store.controller.js";

const router = express.Router();

// Public — powers the /store/:handle page, no session required.
router.get("/by-handle/:handle", getPublicStore);

// Public — lets /api/search attach a matched product's own vendor storefront.
router.get("/by-vendor/:vendorId", getStoreByVendorId);

// Public — feeds the "/" homepage's marketplace preview grid.
router.get("/marketplace-preview", getMarketplacePreview);

// Public — feeds the "/" homepage's Vendors section.
router.get("/vendors-preview", getVendorsPreview);

// Public — backs the /s/p/:id short-link redirector (velte frontend).
router.get("/products/:id/image", getProductImage);

// Public — feeds velte's dynamic sitemap.xml.
router.get("/sitemap-handles", listStoreHandlesForSitemap);

// Vendor-owned store management.
router.get("/me", verifyAuth, getMyStore);
router.put("/me", verifyAuth, updateMyStore);

// Connected Catalogs (spec §16.1) — connect the vendor's own website.
router.post("/connect-catalog", verifyAuth, connectCatalog);

export default router;
