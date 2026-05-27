import Category from '../../models/Category.model.js';
import { errRes } from '../../helpers/apiResponse.js';

export const listCategories = async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    return res.json({
      success: true,
      data: categories.map(cat => ({ id: cat._id, name: cat.name, emoji: cat.emoji })),
    });
  } catch (err) {
    console.error('List categories error:', err);
    return errRes(res, 500, 'INTERNAL_ERROR', 'Failed to fetch categories');
  }
};
