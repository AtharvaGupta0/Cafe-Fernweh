/**
 * Inlined SQL used to self-initialize the database when no pre-applied D1
 * migrations are available (standalone demo mode).
 *
 * The seed is idempotent and guarded by an empty-table check in
 * ensureInitialized(), so it never wipes existing sales data. These strings
 * mirror db/schema.sql and db/seeds/seed.sql; keep them in sync when the
 * schema changes.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  dietary_classification TEXT NOT NULL DEFAULT 'none',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS product_ingredients (
  product_id INTEGER NOT NULL REFERENCES products(id),
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  PRIMARY KEY (product_id, ingredient_id)
);
CREATE TABLE IF NOT EXISTS allergens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS product_allergens (
  product_id INTEGER NOT NULL REFERENCES products(id),
  allergen_id INTEGER NOT NULL REFERENCES allergens(id),
  verified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, allergen_id)
);
CREATE TABLE IF NOT EXISTS sales_transactions (
  id INTEGER PRIMARY KEY,
  total_cents INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transaction_items (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES sales_transactions(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_available ON products(available);
CREATE INDEX IF NOT EXISTS idx_transaction_items_product ON transaction_items(product_id);
CREATE INDEX IF NOT EXISTS idx_transaction_items_transaction ON transaction_items(transaction_id);
`;

export const SEED_SQL = `DELETE FROM transaction_items;
DELETE FROM sales_transactions;
DELETE FROM product_allergens;
DELETE FROM product_ingredients;
DELETE FROM products;
DELETE FROM categories;
DELETE FROM allergens;
DELETE FROM ingredients;

INSERT OR REPLACE INTO categories (id, name, description) VALUES
(1, 'Coffee', 'Hot and iced espresso-based and brewed coffee drinks.'),
(2, 'Tea', 'Classic and spiced teas, hot and chilled.'),
(3, 'Cold Drinks', 'Chilled non-coffee beverages.'),
(4, 'Snacks', 'Savoury and light bites.'),
(5, 'Bakery', 'Freshly baked sweets and pastries.');

INSERT OR REPLACE INTO products
  (id, category_id, name, description, price_cents, available, dietary_classification)
VALUES
(1, 1, 'Espresso', 'A concentrated shot of arabica coffee, served black.', 9000, 1, 'vegan'),
(2, 1, 'Americano', 'Espresso with hot water, smooth and black.', 11000, 1, 'vegan'),
(3, 1, 'Cappuccino', 'Espresso with steamed milk and milk foam.', 16000, 1, 'none'),
(4, 1, 'Latte', 'Espresso with steamed milk and light foam.', 17000, 1, 'none'),
(5, 1, 'Flat White', 'Espresso with micro-foamed milk.', 17500, 1, 'none'),
(6, 1, 'Mocha', 'Espresso, chocolate and steamed milk.', 19000, 0, 'none'),
(7, 1, 'Cold Brew', 'Cold-steeped arabica, served over ice.', 14000, 1, 'vegan'),
(8, 1, 'Iced Latte', 'Espresso and cold milk over ice.', 16500, 1, 'none'),
(9, 2, 'Masala Chai', 'Spiced black tea brewed with milk.', 6000, 1, 'none'),
(10, 2, 'English Breakfast', 'Classic black tea, served plain.', 7000, 1, 'vegan'),
(11, 2, 'Green Tea', 'Light, grassy green tea.', 7500, 1, 'vegan'),
(12, 2, 'Iced Lemon Tea', 'Chilled black tea with lemon.', 9000, 1, 'vegan'),
(13, 3, 'Iced Coffee', 'Chilled coffee with milk over ice.', 15000, 1, 'none'),
(14, 3, 'Mango Lassi', 'Chilled yogurt drink with mango.', 12000, 1, 'none'),
(15, 3, 'Mint Lemonade', 'Fresh mint, lemon, chilled water.', 10000, 1, 'vegan'),
(16, 3, 'Iced Matcha Latte', 'Matcha with cold milk over ice.', 18000, 0, 'none'),
(17, 4, 'Veg Samosa', 'Crispy pastry with spiced potato filling.', 5000, 1, 'vegan'),
(18, 4, 'Paneer Tikka Wrap', 'Grilled paneer and vegetables in a wrap.', 14000, 1, 'vegetarian'),
(19, 4, 'Aloo Tikki Burger', 'Spiced potato patty in a soft bun.', 11000, 1, 'vegetarian'),
(20, 4, 'Masala Peanuts', 'Roasted peanuts with spices.', 6000, 1, 'vegan'),
(21, 5, 'Butter Croissant', 'Flaky butter pastry.', 11000, 1, 'none'),
(22, 5, 'Banana Muffin', 'Moist banana muffin.', 10000, 1, 'none'),
(23, 5, 'Chocolate Brownie', 'Rich chocolate brownie.', 13000, 1, 'none'),
(24, 5, 'Almond Cake', 'Moist almond cake.', 14000, 0, 'none'),
(25, 5, 'Vegan Cookie', 'Oat and chocolate chip cookie, plant-based.', 7000, 1, 'vegan');

INSERT OR REPLACE INTO ingredients (id, name) VALUES
(1, 'Water'),(2, 'Arabica coffee'),(3, 'Milk'),(4, 'Chocolate'),(5, 'Black tea'),(6, 'Green tea'),(7, 'Lemon'),(8, 'Mint'),(9, 'Mango'),(10, 'Yogurt'),(11, 'Matcha'),(12, 'Potato'),(13, 'Wheat flour'),(14, 'Paneer'),(15, 'Peanuts'),(16, 'Butter'),(17, 'Eggs'),(18, 'Banana'),(19, 'Oats'),(20, 'Chocolate chips'),(21, 'Plant oil'),(22, 'Almonds'),(23, 'Spices');

INSERT OR REPLACE INTO product_ingredients (product_id, ingredient_id) VALUES
(1, 1),(1, 2),(2, 1),(2, 2),(3, 2),(3, 3),(4, 2),(4, 3),(5, 2),(5, 3),(6, 2),(6, 3),(6, 4),(7, 1),(7, 2),(8, 2),(8, 3),(9, 5),(9, 3),(10, 1),(10, 5),(11, 1),(11, 6),(12, 1),(12, 5),(12, 7),(13, 2),(13, 3),(14, 9),(14, 10),(15, 1),(15, 7),(15, 8),(16, 11),(16, 3),(17, 12),(17, 13),(17, 21),(17, 23),(18, 13),(18, 14),(18, 23),(19, 12),(19, 13),(19, 16),(19, 17),(20, 15),(21, 13),(21, 16),(21, 17),(22, 13),(22, 16),(22, 17),(22, 18),(23, 4),(23, 16),(23, 17),(23, 13),(24, 22),(24, 13),(24, 16),(24, 17),(25, 19),(25, 20),(25, 21);

INSERT OR REPLACE INTO allergens (id, name) VALUES
(1, 'Milk'),(2, 'Eggs'),(3, 'Gluten (wheat)'),(4, 'Peanuts'),(5, 'Almonds'),(6, 'Soy');

INSERT OR REPLACE INTO product_allergens (product_id, allergen_id, verified) VALUES
(3, 1, 1),(4, 1, 1),(5, 1, 1),(6, 1, 1),(8, 1, 1),(1, 5, 0),(9, 1, 1),(13, 1, 1),(14, 1, 1),(16, 1, 1),(17, 3, 1),(17, 5, 0),(18, 1, 1),(18, 3, 1),(19, 3, 1),(20, 4, 1),(21, 1, 1),(21, 2, 1),(21, 3, 1),(22, 1, 1),(22, 2, 1),(22, 3, 1),(23, 1, 1),(23, 2, 1),(23, 3, 1),(23, 5, 0),(24, 1, 1),(24, 2, 1),(24, 3, 1),(24, 5, 1),(25, 3, 0);

INSERT OR REPLACE INTO sales_transactions (id, total_cents, created_at) VALUES
(1, 23000, '2026-10-27T08:15:00Z'),(2, 27000, '2026-10-27T08:42:00Z'),(3, 17000, '2026-10-27T09:05:00Z'),(4, 18000, '2026-10-27T09:30:00Z'),(5, 14000, '2026-10-27T09:55:00Z'),(6, 23500, '2026-10-27T10:10:00Z'),(7, 27000, '2026-10-27T10:35:00Z'),(8, 25000, '2026-10-27T11:00:00Z'),(9, 12000, '2026-10-27T11:25:00Z'),(10, 45000, '2026-10-27T11:50:00Z'),(11, 7500, '2026-10-27T12:15:00Z'),(12, 20000, '2026-10-27T12:40:00Z'),(13, 17500, '2026-10-27T13:05:00Z'),(14, 19000, '2026-10-27T13:30:00Z'),(15, 19000, '2026-10-27T13:55:00Z'),(16, 26000, '2026-10-27T14:20:00Z'),(17, 27000, '2026-10-27T14:45:00Z'),(18, 15000, '2026-10-27T15:10:00Z'),(19, 20000, '2026-10-27T15:35:00Z'),(20, 36000, '2026-10-27T16:00:00Z'),(21, 18000, '2026-10-28T08:20:00Z'),(22, 34000, '2026-10-28T08:55:00Z'),(23, 18000, '2026-10-28T09:20:00Z'),(24, 14000, '2026-10-28T09:45:00Z'),(25, 29500, '2026-10-28T10:10:00Z'),(26, 14000, '2026-10-28T10:35:00Z'),(27, 12500, '2026-10-28T11:00:00Z'),(28, 28500, '2026-10-28T11:25:00Z');

INSERT OR REPLACE INTO transaction_items (id, transaction_id, product_id, quantity, unit_price_cents) VALUES
(1, 1, 1, 2, 9000),(2, 1, 17, 1, 5000),(3, 2, 3, 1, 16000),(4, 2, 21, 1, 11000),(5, 3, 4, 1, 17000),(6, 4, 9, 1, 6000),(7, 4, 20, 2, 6000),(8, 5, 7, 1, 14000),(9, 6, 8, 1, 16500),(10, 6, 25, 1, 7000),(11, 7, 1, 3, 9000),(12, 8, 2, 1, 11000),(13, 8, 18, 1, 14000),(14, 9, 14, 1, 12000),(15, 10, 3, 2, 16000),(16, 10, 23, 1, 13000),(17, 11, 11, 1, 7500),(18, 12, 12, 1, 9000),(19, 12, 19, 1, 11000),(20, 13, 5, 1, 17500),(21, 14, 10, 2, 7000),(22, 14, 17, 1, 5000),(23, 15, 6, 1, 19000),(24, 16, 7, 1, 14000),(25, 16, 20, 2, 6000),(26, 17, 4, 1, 17000),(27, 17, 22, 1, 10000),(28, 18, 13, 1, 15000),(29, 19, 9, 1, 6000),(30, 19, 18, 1, 14000),(31, 20, 1, 4, 9000),(32, 21, 2, 1, 11000),(33, 21, 25, 1, 7000),(34, 22, 3, 1, 16000),(35, 22, 21, 1, 11000),(36, 22, 25, 1, 7000),(37, 23, 14, 1, 12000),(38, 23, 20, 1, 6000),(39, 24, 7, 1, 14000),(40, 25, 8, 1, 16500),(41, 25, 23, 1, 13000),(42, 26, 24, 1, 14000),(43, 27, 11, 1, 7500),(44, 27, 17, 1, 5000),(45, 28, 5, 1, 17500),(46, 28, 19, 1, 11000);
`;
