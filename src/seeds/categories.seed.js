import dotenv from 'dotenv-flow';
dotenv.config();

import mongoose from 'mongoose';
import Category from '../models/Category.model.js';

const RETAIL_CATEGORIES = [
  { _id: 'electronics',  name: 'Electronics',      emoji: '💻' },
  { _id: 'fashion',      name: 'Fashion',           emoji: '👗' },
  { _id: 'accessories',  name: 'Accessories',       emoji: '👜' },
  { _id: 'home-kitchen', name: 'Home & Kitchen',    emoji: '🏠' },
  { _id: 'sports',       name: 'Sports & Outdoors', emoji: '⚽' },
  { _id: 'toys',         name: 'Toys & Games',      emoji: '🎮' },
  { _id: 'health',       name: 'Health & Fitness',  emoji: '💪' },
  { _id: 'books',        name: 'Books',             emoji: '📚' },
];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  for (const cat of RETAIL_CATEGORIES) {
    await Category.updateOne({ _id: cat._id }, { $set: cat }, { upsert: true });
    console.log(`  ✓ ${cat._id}`);
  }

  console.log('Retail categories seeded.');
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
