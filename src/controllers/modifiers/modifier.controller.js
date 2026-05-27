import ModifierOption from '../../models/ModifierOption.model.js';
import Product from '../../models/Product.model.js';
import { errRes } from '../../helpers/apiResponse.js';

function formatOption(opt) {
  return {
    id:               opt._id,
    name:             opt.name,
    additional_price: opt.additionalPrice,
    created_at:       opt.createdAt,
    updated_at:       opt.updatedAt,
  };
}

export const listModifierOptions = async (req, res) => {
  try {
    const options = await ModifierOption
      .find({ vendorId: req.user.userId })
      .sort({ name: 1 });

    return res.json({ success: true, data: options.map(formatOption) });
  } catch (err) {
    console.error('List modifier options error:', err);
    return errRes(res, 500, 'INTERNAL_ERROR', 'Failed to fetch modifier options');
  }
};

export const createModifierOption = async (req, res) => {
  try {
    const { name, additional_price } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return errRes(res, 400, 'VALIDATION_ERROR', 'Validation failed', { name: 'Name is required' });
    }
    if (additional_price !== undefined && (typeof additional_price !== 'number' || additional_price < 0)) {
      return errRes(res, 400, 'VALIDATION_ERROR', 'Validation failed', { additional_price: 'Must be a non-negative number' });
    }

    const option = await ModifierOption.create({
      vendorId:        req.user.userId,
      name:            name.trim(),
      additionalPrice: additional_price ?? 0,
    });

    return res.status(201).json({ success: true, data: formatOption(option) });
  } catch (err) {
    if (err.code === 11000) {
      return errRes(res, 409, 'CONFLICT', 'A modifier option with this name already exists');
    }
    console.error('Create modifier option error:', err);
    return errRes(res, 500, 'INTERNAL_ERROR', 'Failed to create modifier option');
  }
};

export const updateModifierOption = async (req, res) => {
  try {
    const option = await ModifierOption.findOne({ _id: req.params.id, vendorId: req.user.userId });
    if (!option) return errRes(res, 404, 'NOT_FOUND', 'Modifier option not found');

    const { name, additional_price } = req.body;

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return errRes(res, 400, 'VALIDATION_ERROR', 'Validation failed', { name: 'Name cannot be empty' });
      }
      option.name = name.trim();
    }

    if (additional_price !== undefined) {
      if (typeof additional_price !== 'number' || additional_price < 0) {
        return errRes(res, 400, 'VALIDATION_ERROR', 'Validation failed', { additional_price: 'Must be a non-negative number' });
      }
      option.additionalPrice = additional_price;
    }

    await option.save();
    return res.json({ success: true, data: formatOption(option) });
  } catch (err) {
    if (err.code === 11000) {
      return errRes(res, 409, 'CONFLICT', 'A modifier option with this name already exists');
    }
    console.error('Update modifier option error:', err);
    return errRes(res, 500, 'INTERNAL_ERROR', 'Failed to update modifier option');
  }
};

export const deleteModifierOption = async (req, res) => {
  try {
    const option = await ModifierOption.findOne({ _id: req.params.id, vendorId: req.user.userId });
    if (!option) return errRes(res, 404, 'NOT_FOUND', 'Modifier option not found');

    const inUse = await Product.exists({ 'modifiers.options': option._id });
    if (inUse) {
      return errRes(res, 409, 'CONFLICT', 'Cannot delete a modifier option that is assigned to one or more products');
    }

    await option.deleteOne();
    return res.json({ success: true });
  } catch (err) {
    console.error('Delete modifier option error:', err);
    return errRes(res, 500, 'INTERNAL_ERROR', 'Failed to delete modifier option');
  }
};
