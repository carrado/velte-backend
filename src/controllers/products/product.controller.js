import Product, { FOOD_CATEGORIES } from "../../models/Product.model.js";
import ModifierOption from "../../models/ModifierOption.model.js";
import Category from "../../models/Category.model.js";
import User from "../../models/Users.js";
import { errRes } from "../../helpers/apiResponse.js";
import { embedAndSaveProduct } from "../../services/retrieval.service.js";

// ── business-type shape helpers ───────────────────────────────────────────────
// Product logic branches on *shape*, not the raw businessType:
//   • food-shaped  → dish tooling (prep time, modifiers, availability)
//   • retail-shaped → stock, low-stock threshold, dates
// "food" and "food_both" are food vendors; but in a food_both account a *service*
// listing is still service-shaped (retail-shaped, no stock), so shape depends on
// both the account type AND the listing's kind.
const FOOD_TYPES = ["food", "food_both"];
const isFoodVendor = (businessType) => FOOD_TYPES.includes(businessType);
const usesFoodShape = (businessType, kind) =>
  isFoodVendor(businessType) && kind !== "service";

// ── formatters ────────────────────────────────────────────────────────────────

function formatModifierOption(opt) {
  return {
    id: opt._id ?? opt.id,
    name: opt.name,
    additional_price: opt.additionalPrice,
  };
}

function formatProduct(doc) {
  const p = doc.toObject({ virtuals: true });

  const base = {
    id: p._id,
    vendor_id: p.vendorId,
    business_type: p.businessType,
    kind: p.kind ?? "product",
    quote_on_request: p.quoteOnRequest ?? false,
    name: p.name,
    description: p.description,
    category_id: p.categoryId,
    price: p.price,
    price_max: p.priceMax ?? null,
    currency: p.currency,
    is_featured: p.isFeatured,
    tags: p.tags,
    main_image_url: p.mainImageUrl,
    thumbnail_urls: p.thumbnailUrls,
    video_url: p.videoUrl,
    color_class: p.colorClass,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };

  if (!usesFoodShape(p.businessType, p.kind)) {
    return {
      ...base,
      stock_quantity: p.stockQuantity,
      ordered_quantity: p.orderedQuantity,
      low_stock_threshold: p.lowStockThreshold,
      manufacturing_date: p.manufacturingDate,
      expiration_date: p.expirationDate,
      attributes: (p.attributes ?? []).map((a) => ({
        id: a._id,
        name: a.name,
        value: a.value,
      })),
    };
  }

  return {
    ...base,
    estimated_prep_mins: p.estimatedPrepMins,
    is_currently_available: p.isCurrentlyAvailable,
    daily_limit: p.dailyLimit,
    allow_pre_order: p.allowPreOrder,
    modifiers: (p.modifiers ?? []).map((mg) => ({
      id: mg._id,
      name: mg.name,
      required: mg.required,
      multi_select: mg.multiSelect,
      options: (mg.options ?? []).map((opt) =>
        opt && typeof opt === "object" && opt.name
          ? formatModifierOption(opt)
          : { id: opt, name: null, additional_price: null },
      ),
    })),
  };
}

// ── validation ────────────────────────────────────────────────────────────────

function validateProductInput(body, businessType) {
  const fields = {};
  const kind = body.kind ?? "product";

  if (!["product", "service"].includes(kind)) {
    fields.kind = 'kind must be "product" or "service"';
  }
  // Food catalogs are dish-shaped (prep time, modifiers, daily limits) —
  // services don't fit that mold, so they're retail-only for now.
  if (kind === "service" && businessType === "food") {
    fields.kind = "Services are not supported for food vendors yet";
  }

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    fields.name = "Name is required";
  } else if (body.name.trim().length > 120) {
    fields.name = "Name must be 120 characters or fewer";
  }

  // Quote-on-request services carry no upfront price.
  const quoteOnRequest = kind === "service" && body.quote_on_request === true;
  if (!quoteOnRequest) {
    if (body.price === undefined || body.price === null) {
      fields.price = "Price is required";
    } else if (typeof body.price !== "number" || body.price < 0) {
      fields.price = "Price must be a non-negative number";
    }
  }

  // Optional price range: price_max is the high end and must exceed price.
  if (body.price_max !== undefined && body.price_max !== null) {
    if (typeof body.price_max !== "number" || body.price_max < 0) {
      fields.price_max = "price_max must be a non-negative number";
    } else if (body.price_max <= (body.price ?? 0)) {
      fields.price_max = "price_max must be greater than price";
    }
  }

  // Services carry no category — discovered by meaning, not a fixed bucket.
  if (kind !== "service" && !body.category_id) {
    fields.category_id = "category_id is required";
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) {
      fields.tags = "tags must be an array";
    } else if (body.tags.length > 20) {
      fields.tags = "Maximum 20 tags allowed";
    } else if (body.tags.some((t) => t.length > 30)) {
      fields.tags = "Each tag must be 30 characters or fewer";
    }
  }

  if (
    body.thumbnail_urls !== undefined &&
    Array.isArray(body.thumbnail_urls) &&
    body.thumbnail_urls.length > 5
  ) {
    fields.thumbnail_urls = "Maximum 5 thumbnail URLs allowed";
  }

  if (!usesFoodShape(businessType, kind)) {
    // Services carry no stock — quantity only required for stocked goods.
    if (
      kind !== "service" &&
      (body.stock_quantity === undefined || body.stock_quantity === null)
    ) {
      fields.stock_quantity = "stock_quantity is required for retail products";
    }
    if (body.manufacturing_date && body.expiration_date) {
      if (new Date(body.expiration_date) <= new Date(body.manufacturing_date)) {
        fields.expiration_date =
          "expiration_date must be after manufacturing_date";
      }
    }
  }

  if (usesFoodShape(businessType, kind)) {
    if (body.category_id && !FOOD_CATEGORIES.includes(body.category_id)) {
      fields.category_id = `category_id must be one of: ${FOOD_CATEGORIES.join(", ")}`;
    }
    if (
      body.estimated_prep_mins === undefined ||
      body.estimated_prep_mins === null
    ) {
      fields.estimated_prep_mins =
        "estimated_prep_mins is required for food products";
    } else if (body.estimated_prep_mins < 5) {
      fields.estimated_prep_mins =
        "estimated_prep_mins must be at least 5 minutes";
    }
    if (body.daily_limit !== undefined && body.daily_limit !== null) {
      if (!Number.isInteger(body.daily_limit) || body.daily_limit <= 0) {
        fields.daily_limit = "daily_limit must be a positive integer";
      }
    }
    for (const mod of body.modifiers ?? []) {
      for (const opt of mod.options ?? []) {
        if (
          opt.additional_price !== undefined &&
          opt.additional_price !== null &&
          opt.additional_price < 0
        ) {
          fields.modifiers =
            "Modifier option additional_price cannot be negative";
        }
      }
    }
  }

  return Object.keys(fields).length > 0
    ? { message: "Validation failed", fields }
    : null;
}

// ── modifier resolution ───────────────────────────────────────────────────────

// Resolves the modifier groups from the request body into embedded group objects
// whose option arrays contain ModifierOption ObjectId references.
//
// Price ownership rule: if an option already exists for this vendor (matched by
// name), the stored price wins — it can only be changed via PUT /api/modifiers/:id.
// A new option is created only when the name is not yet in the vendor's catalog.
async function resolveModifiers(modifiers, vendorId) {
  const resolved = [];

  for (const group of modifiers) {
    const optionIds = [];

    for (const opt of group.options ?? []) {
      let record = null;

      if (opt.id) {
        record = await ModifierOption.findOne({ _id: opt.id, vendorId });
      }
      if (!record && opt.name) {
        record = await ModifierOption.findOne({
          vendorId,
          name: opt.name.trim(),
        });
      }
      if (!record && opt.name) {
        record = await ModifierOption.create({
          vendorId,
          name: opt.name.trim(),
          additionalPrice: opt.additional_price ?? 0,
        });
      }

      if (record) optionIds.push(record._id);
    }

    resolved.push({
      name: group.name,
      required: group.required ?? false,
      multiSelect: group.multi_select ?? false,
      options: optionIds,
    });
  }

  return resolved;
}

// ── controllers ───────────────────────────────────────────────────────────────

export const getProducts = async (req, res) => {
  try {
    const { userId } = req.user;
    const {
      page = 1,
      limit = 10,
      category_id,
      tab = "all",
      search,
      stock_status,
      sort_by = "created_at",
      sort_order = "desc",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));

    const vendor = await User.findById(userId).select("businessType").lean();
    if (!vendor) return errRes(res, 401, "UNAUTHORIZED", "Vendor not found");

    const { businessType } = vendor;
    const filter = { vendorId: userId };

    if (category_id) filter.categoryId = category_id;
    if (search) filter.name = { $regex: search, $options: "i" };

    if (tab === "featured") filter.isFeatured = true;
    // Services carry no stock: never "out of stock", always "in stock".
    const foodVendor = isFoodVendor(businessType);
    if (tab === "out-of-stock") {
      if (!foodVendor) {
        filter.stockQuantity = 0;
        filter.kind = { $ne: "service" };
      } else filter.isCurrentlyAvailable = false;
    }

    if (stock_status === "in-stock") {
      if (!foodVendor) {
        filter.$or = [{ stockQuantity: { $gt: 0 } }, { kind: "service" }];
      } else filter.isCurrentlyAvailable = true;
    } else if (stock_status === "out-of-stock") {
      if (!foodVendor) {
        filter.stockQuantity = 0;
        filter.kind = { $ne: "service" };
      } else filter.isCurrentlyAvailable = false;
    }

    const sortField = sort_by === "price" ? "price" : "createdAt";
    const sortDir = sort_order === "asc" ? 1 : -1;

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate("modifiers.options")
        .sort({ [sortField]: sortDir })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      Product.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: {
        products: products.map(formatProduct),
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (err) {
    console.error("Get products error:", err);
    return errRes(res, 500, "INTERNAL_ERROR", "Failed to fetch products");
  }
};

export const getProduct = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      vendorId: req.user.userId,
    }).populate("modifiers.options");

    if (!product) return errRes(res, 404, "NOT_FOUND", "Product not found");

    return res.json({ success: true, data: formatProduct(product) });
  } catch (err) {
    console.error("Get product error:", err);
    return errRes(res, 500, "INTERNAL_ERROR", "Failed to fetch product");
  }
};

export const createProduct = async (req, res) => {
  try {
    const vendor = await User.findById(req.user.userId)
      .select("businessType")
      .lean();
    if (!vendor) return errRes(res, 401, "UNAUTHORIZED", "Vendor not found");

    const { businessType } = vendor;
    const body = req.body;

    const validationError = validateProductInput(body, businessType);
    if (validationError)
      return errRes(
        res,
        400,
        "VALIDATION_ERROR",
        validationError.message,
        validationError.fields,
      );

    const isService = body.kind === "service";
    const foodShape = usesFoodShape(
      businessType,
      isService ? "service" : "product",
    );
    // Retail-shaped products validate against the seeded Category collection;
    // food dishes use FOOD_CATEGORIES (checked in validateProductInput).
    if (!foodShape && !isService) {
      const cat = await Category.findById(body.category_id);
      if (!cat)
        return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
          category_id: `category_id must be one of the seeded retail categories`,
        });
    }

    const resolvedModifiers =
      foodShape && body.modifiers?.length
        ? await resolveModifiers(body.modifiers, req.user.userId)
        : [];

    const product = await Product.create({
      vendorId: req.user.userId,
      businessType,
      kind: isService ? "service" : "product",
      quoteOnRequest: isService ? (body.quote_on_request ?? false) : false,
      name: body.name.trim(),
      description: body.description ?? null,
      categoryId: isService ? null : body.category_id,
      price: isService && body.quote_on_request ? 0 : body.price,
      priceMax: body.price_max ?? null,
      currency: body.currency ?? "NGN",
      isFeatured: body.is_featured ?? false,
      tags: body.tags ?? [],
      mainImageUrl: body.main_image_url ?? null,
      thumbnailUrls: body.thumbnail_urls ?? [],
      videoUrl: body.video_url ?? null,
      colorClass: body.color_class ?? null,

      ...(!foodShape && {
        stockQuantity: body.kind === "service" ? 0 : body.stock_quantity,
        lowStockThreshold: body.low_stock_threshold ?? null,
        manufacturingDate: body.manufacturing_date ?? null,
        expirationDate: body.expiration_date ?? null,
        attributes: body.attributes ?? [],
      }),

      ...(foodShape && {
        estimatedPrepMins: body.estimated_prep_mins,
        isCurrentlyAvailable: body.is_currently_available ?? true,
        dailyLimit: body.daily_limit ?? null,
        allowPreOrder: body.allow_pre_order ?? false,
        modifiers: resolvedModifiers,
      }),
    });

    await product.populate("modifiers.options");
    // Fire-and-forget: embedding is a search-side concern, must never block
    // or fail product creation.
    embedAndSaveProduct(product);
    return res
      .status(201)
      .json({ success: true, data: formatProduct(product) });
  } catch (err) {
    console.error("Create product error:", err);
    return errRes(res, 500, "INTERNAL_ERROR", "Failed to create product");
  }
};

export const updateProduct = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      vendorId: req.user.userId,
    });
    if (!product) return errRes(res, 404, "NOT_FOUND", "Product not found");

    const { businessType } = product;
    // Shape is fixed by the stored listing (kind never changes on update).
    const foodShape = usesFoodShape(businessType, product.kind);
    const body = req.body;

    // Partial validation — only validate provided fields
    if (
      body.price !== undefined &&
      (typeof body.price !== "number" || body.price < 0)
    ) {
      return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
        price: "Price must be a non-negative number",
      });
    }
    const effectivePrice = body.price ?? product.price;
    if (
      body.price_max !== undefined &&
      body.price_max !== null &&
      body.price_max <= effectivePrice
    ) {
      return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
        price_max: "price_max must be greater than price",
      });
    }
    if (body.category_id) {
      if (!foodShape) {
        const cat = await Category.findById(body.category_id);
        if (!cat)
          return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
            category_id:
              "category_id must be one of the seeded retail categories",
          });
      } else if (!FOOD_CATEGORIES.includes(body.category_id)) {
        return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
          category_id: `category_id must be one of: ${FOOD_CATEGORIES.join(", ")}`,
        });
      }
    }
    if (body.tags !== undefined && body.tags.length > 20) {
      return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
        tags: "Maximum 20 tags allowed",
      });
    }
    if (body.thumbnail_urls !== undefined && body.thumbnail_urls.length > 5) {
      return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
        thumbnail_urls: "Maximum 5 thumbnail URLs allowed",
      });
    }

    // `kind` is deliberately absent — an offering's identity is fixed at
    // creation; flipping product↔service mid-life would corrupt stock/lead
    // semantics.
    const shared = {
      quote_on_request: "quoteOnRequest",
      name: "name",
      description: "description",
      category_id: "categoryId",
      price: "price",
      price_max: "priceMax",
      currency: "currency",
      is_featured: "isFeatured",
      tags: "tags",
      main_image_url: "mainImageUrl",
      thumbnail_urls: "thumbnailUrls",
      video_url: "videoUrl",
      color_class: "colorClass",
    };
    for (const [snake, camel] of Object.entries(shared)) {
      if (body[snake] !== undefined) {
        product[camel] = snake === "name" ? body[snake].trim() : body[snake];
      }
    }

    if (!foodShape) {
      const retailMap = {
        stock_quantity: "stockQuantity",
        low_stock_threshold: "lowStockThreshold",
        manufacturing_date: "manufacturingDate",
        expiration_date: "expirationDate",
        attributes: "attributes",
      };
      for (const [snake, camel] of Object.entries(retailMap)) {
        if (body[snake] !== undefined) product[camel] = body[snake];
      }
    }

    if (foodShape) {
      const foodMap = {
        estimated_prep_mins: "estimatedPrepMins",
        is_currently_available: "isCurrentlyAvailable",
        daily_limit: "dailyLimit",
        allow_pre_order: "allowPreOrder",
      };
      for (const [snake, camel] of Object.entries(foodMap)) {
        if (body[snake] !== undefined) product[camel] = body[snake];
      }
      if (body.modifiers !== undefined) {
        product.modifiers = await resolveModifiers(
          body.modifiers,
          req.user.userId,
        );
      }
    }

    await product.save();
    await product.populate("modifiers.options");
    // Semantic fields (name/description/category/attributes) may have
    // changed — re-embed. Fire-and-forget, same as create.
    embedAndSaveProduct(product);

    return res.json({ success: true, data: formatProduct(product) });
  } catch (err) {
    console.error("Update product error:", err);
    return errRes(res, 500, "INTERNAL_ERROR", "Failed to update product");
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      vendorId: req.user.userId,
    });
    if (!product) return errRes(res, 404, "NOT_FOUND", "Product not found");

    const foodShape = usesFoodShape(product.businessType, product.kind);
    if (!foodShape && product.stockQuantity > 0) {
      return errRes(
        res,
        409,
        "CONFLICT",
        "Cannot delete a product with remaining stock. Set stock to 0 first",
      );
    }
    if (foodShape && product.isCurrentlyAvailable) {
      return errRes(
        res,
        409,
        "CONFLICT",
        "Cannot delete an available food item. Disable availability first",
      );
    }

    await product.deleteOne();
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete product error:", err);
    return errRes(res, 500, "INTERNAL_ERROR", "Failed to delete product");
  }
};

export const toggleAvailability = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      vendorId: req.user.userId,
    });
    if (!product) return errRes(res, 404, "NOT_FOUND", "Product not found");
    if (!usesFoodShape(product.businessType, product.kind)) {
      return errRes(
        res,
        400,
        "VALIDATION_ERROR",
        "Availability toggle is only for food items",
      );
    }

    const { is_currently_available } = req.body;
    if (typeof is_currently_available !== "boolean") {
      return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
        is_currently_available: "Must be a boolean",
      });
    }

    product.isCurrentlyAvailable = is_currently_available;
    await product.save();

    return res.json({
      success: true,
      data: {
        id: product._id,
        is_currently_available: product.isCurrentlyAvailable,
      },
    });
  } catch (err) {
    console.error("Toggle availability error:", err);
    return errRes(res, 500, "INTERNAL_ERROR", "Failed to update availability");
  }
};

export const restockProduct = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      vendorId: req.user.userId,
    });
    if (!product) return errRes(res, 404, "NOT_FOUND", "Product not found");
    if (
      usesFoodShape(product.businessType, product.kind) ||
      product.kind === "service"
    ) {
      return errRes(
        res,
        400,
        "VALIDATION_ERROR",
        "Restock is only available for stocked products",
      );
    }

    const quantity = parseInt(req.body.quantity, 10);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
        quantity: "Must be a positive integer",
      });
    }

    product.stockQuantity =
      product.stockQuantity === 0 ? quantity : product.stockQuantity + quantity;
    await product.save();

    return res.json({ success: true, data: formatProduct(product) });
  } catch (err) {
    console.error("Restock error:", err);
    return errRes(res, 500, "INTERNAL_ERROR", "Failed to restock product");
  }
};

export const changePrice = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      vendorId: req.user.userId,
    });
    if (!product) return errRes(res, 404, "NOT_FOUND", "Product not found");

    const price = parseFloat(req.body.price);
    if (isNaN(price) || price <= 0) {
      return errRes(res, 400, "VALIDATION_ERROR", "Validation failed", {
        price: "Must be a positive number",
      });
    }

    product.price = price;
    await product.save();
    await product.populate("modifiers.options");

    return res.json({ success: true, data: formatProduct(product) });
  } catch (err) {
    console.error("Change price error:", err);
    return errRes(res, 500, "INTERNAL_ERROR", "Failed to update price");
  }
};

// Internal — triggered by midnight cron. Restores availability for food products
// that were auto-disabled when their daily_limit was exhausted.
export const resetDailyLimits = async (req, res) => {
  try {
    const result = await Product.updateMany(
      { businessType: "food", dailyLimitDisabled: true },
      {
        $set: {
          isCurrentlyAvailable: true,
          dailyOrderCount: 0,
          dailyLimitDisabled: false,
        },
      },
    );
    return res.json({ success: true, data: { reset: result.modifiedCount } });
  } catch (err) {
    console.error("Reset daily limits error:", err);
    return errRes(res, 500, "INTERNAL_ERROR", "Failed to reset daily limits");
  }
};
