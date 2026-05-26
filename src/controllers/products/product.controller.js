import Product from "../../models/Product.model.js";

export const createProduct = async (req, res) => {
  try {
    const {
      name, description, price, category, imageUrl, inStock,
      modifiers, availability, estimatedPrepMins, isVeg, isSpicy,
    } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ message: "name and price are required" });
    }

    const product = await Product.create({
      merchantId: req.user.userId,
      name,
      description,
      price,
      category,
      imageUrl,
      inStock,
      modifiers,
      availability,
      estimatedPrepMins,
      isVeg,
      isSpicy,
    });

    res.status(201).json({ success: true, product });
  } catch (error) {
    console.error("Create product error:", error);
    res.status(500).json({ message: "Failed to create product" });
  }
};

export const getProducts = async (req, res) => {
  try {
    const products = await Product.find({ merchantId: req.user.userId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, products });
  } catch (error) {
    console.error("Get products error:", error);
    res.status(500).json({ message: "Failed to fetch products" });
  }
};

export const getProduct = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, merchantId: req.user.userId });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json({ success: true, product });
  } catch (error) {
    console.error("Get product error:", error);
    res.status(500).json({ message: "Failed to fetch product" });
  }
};

export const updateProduct = async (req, res) => {
  try {
    const allowed = [
      'name', 'description', 'price', 'category', 'imageUrl', 'inStock',
      'modifiers', 'availability', 'estimatedPrepMins', 'isVeg', 'isSpicy',
    ];

    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.userId },
      update,
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json({ success: true, product });
  } catch (error) {
    console.error("Update product error:", error);
    res.status(500).json({ message: "Failed to update product" });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({ _id: req.params.id, merchantId: req.user.userId });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json({ success: true, message: "Product deleted" });
  } catch (error) {
    console.error("Delete product error:", error);
    res.status(500).json({ message: "Failed to delete product" });
  }
};
