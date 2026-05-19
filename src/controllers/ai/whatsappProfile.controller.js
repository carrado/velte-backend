import AISetup from "../../models/AiSetup.model.js";
import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  getWhatsAppBusinessProfile,
  updateWhatsAppBusinessProfile,
  uploadWhatsAppProfilePhoto,
  getOrCreateWABACatalog,
  syncCatalogProducts,
  setWhatsAppCommerceSettings,
  getWABACatalogId,
  getCatalogItems,
} from "../../services/meta.service.js";

async function getSetupWithMeta(userId) {
  const setup = await AISetup.findOne({ userId }).select("+metaAccessToken");
  if (!setup?.metaConnected || !setup.selectedNumberId) {
    throw new AppError(
      "Connect WhatsApp and select a phone number in AI Setup first.",
      400,
    );
  }
  if (!setup.metaAccessToken) {
    throw new AppError("Meta session expired. Reconnect WhatsApp.", 401);
  }
  return setup;
}

function mapMetaProfile(row, businessName) {
  if (!row) return null;
  return {
    businessName: businessName ?? "",
    about: row.about ?? "",
    address: row.address ?? "",
    description: row.description ?? "",
    email: row.email ?? "",
    website: row.websites?.[0] ?? "",
    vertical: row.vertical ?? "RETAIL",
    profilePictureUrl: row.profile_picture_url ?? null,
  };
}

function buildCatalogProductPayload(product) {
  const encodedName = encodeURIComponent(product.name.slice(0, 40));
  return {
    retailerId: `velte_${product.id}`,
    name: product.name,
    description: product.name,
    price: product.price,
    inStock: product.inStock ?? 0,
    imageUrl: `https://placehold.co/600x600/png?text=${encodedName}`,
    link: "https://velte.ng",
  };
}

// ── GET /ai-setup/whatsapp-profile ────────────────────────────────────────────

export async function getWhatsAppProfile(req, res, next) {
  try {
    const setup = await getSetupWithMeta(req.user.userId);
    const user = await User.findById(req.user.userId).select("company avatar");

    let metaProfile = null;
    try {
      const raw = await getWhatsAppBusinessProfile(
        setup.selectedNumberId,
        setup.metaAccessToken,
      );
      metaProfile = mapMetaProfile(raw, user?.company?.name);
    } catch (err) {
      console.warn("WhatsApp profile fetch:", err.message);
    }

    // Fetch catalog products directly from Meta — nothing is stored in DB.
    let catalogProducts = [];
    try {
      const catalogId = await getWABACatalogId(setup.wabaId, setup.metaAccessToken);
      if (catalogId) {
        const items = await getCatalogItems(catalogId, setup.metaAccessToken);
        catalogProducts = items.map((p) => ({
          id: p.retailer_id?.replace("velte_", "") ?? p.retailer_id,
          name: p.name,
          price: p.price,
          availability: p.availability,
        }));
      }
    } catch (err) {
      console.warn("Catalog products fetch:", err.message);
    }

    res.json({
      success: true,
      data: {
        profile: metaProfile,
        userAvatar: user?.avatar ?? null,
        services: user?.company?.services ?? [],
        catalogProducts,
        metaConnected: true,
        selectedNumberId: setup.selectedNumberId,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── PUT /ai-setup/whatsapp-profile ────────────────────────────────────────────

export async function saveWhatsAppProfile(req, res, next) {
  try {
    const {
      about,
      address,
      website,
      email,
      vertical,
      services,
      featuredProducts,
    } = req.body;

    const setup = await getSetupWithMeta(req.user.userId);
    const phoneNumberId = setup.selectedNumberId;
    const accessToken = setup.metaAccessToken;

    const websites = website?.trim() ? [website.trim()] : [];
    const servicesList = Array.isArray(services) ? services : [];
    const description = servicesList.length > 0 ? servicesList.join(" · ") : "";

    // Fetch user avatar before any Meta calls so we have it for photo sync.
    const user = await User.findById(req.user.userId).select("company avatar");

    // Send all profile fields directly to Meta — nothing saved to DB here.
    await updateWhatsAppBusinessProfile(phoneNumberId, accessToken, {
      about: about?.slice(0, 139) ?? "",
      address: address ?? "",
      description,
      email: email || undefined,
      websites,
      vertical: vertical || "RETAIL",
    });

    // Sync user avatar → WhatsApp Business Profile picture (non-blocking).
    let photoSynced = false;
    let photoError = null;
    if (user?.avatar) {
      try {
        await uploadWhatsAppProfilePhoto(user.avatar, phoneNumberId, accessToken);
        photoSynced = true;
      } catch (err) {
        console.warn("Profile photo sync failed:", err.message);
        photoError = err.message;
      }
    }

    // Only DB write: services array on the User document.
    if (Array.isArray(services)) {
      await User.findByIdAndUpdate(req.user.userId, {
        $set: { "company.services": servicesList },
      });
    }

    // Catalog sync goes directly to Meta. Non-blocking — a permission failure
    // (catalog_management scope missing on the token) must not break the profile save.
    let catalogSynced = false;
    let catalogError = null;

    if (Array.isArray(featuredProducts) && featuredProducts.length > 0) {
      try {
        const { catalogId } = await getOrCreateWABACatalog(
          setup.wabaId,
          accessToken,
          { businessId: setup.metaBusinessId },
        );

        const catalogItems = featuredProducts
          .slice(0, 3)
          .map(buildCatalogProductPayload);

        await syncCatalogProducts(catalogId, accessToken, catalogItems);
        await setWhatsAppCommerceSettings(phoneNumberId, accessToken, {
          isCatalogVisible: true,
          isCartEnabled: true,
        });

        catalogSynced = true;
      } catch (err) {
        console.warn("Catalog sync failed:", err.message);
        catalogError =
          err.message.includes("Missing Permission") || err.message.includes("#100")
            ? "Catalog sync requires catalog_management permission on your Meta account. Re-authenticate with that scope to enable this feature."
            : err.message;
      }
    }

    const fresh = await User.findById(req.user.userId).select("company avatar");

    res.json({
      success: true,
      data: {
        services: fresh?.company?.services ?? servicesList,
        catalogSynced,
        photoSynced,
        ...(catalogError && { catalogError }),
        ...(photoError && { photoError }),
      },
      message: [
        "WhatsApp profile updated",
        catalogSynced && "product catalog synced",
        photoSynced && "profile photo uploaded",
      ]
        .filter(Boolean)
        .join(", "),
    });
  } catch (err) {
    next(err);
  }
}
