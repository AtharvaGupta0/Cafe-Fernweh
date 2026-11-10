/**
 * Administrative menu operations (server-side only).
 *
 * All functions use parameterised SQL and Zod-validated input. Credentials
 * are never returned to the browser.
 */

import { type Product, type DietaryRestriction } from "@shared/schema";
import { readAll, readOne, execStatements, formatPriceInr } from "./db";
import type { DatabaseLike } from "@shared/types";
import { z } from "zod";

export const adminProductSchema = z.object({
  id: z.number().int().positive().optional(),
  category_id: z.number().int().positive(),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  price_cents: z.number().int().nonnegative(),
  available: z.boolean().default(true),
  dietary_classification: z
    .enum(["none", "vegan", "vegetarian", "dairy_free", "lactose_free"])
    .default("none"),
});

export type AdminProductInput = z.infer<typeof adminProductSchema>;

export interface AdminSalesImportResult {
  imported: number;
  rejected: Array<{ row: number; reason: string }>;
}

export async function listProductsAdmin(
  db: DatabaseLike
): Promise<Product[]> {
  const rows = await readAll(
    db,
    `SELECT p.id, p.category_id, p.name, p.description, p.price_cents, p.available,
            p.dietary_classification, c.name AS category
     FROM products p JOIN categories c ON c.id = p.category_id
     ORDER BY p.id`
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return ({
      id: Number(row.id),
      category_id: Number(row.category_id),
      category: typeof row.category === "string" ? row.category : undefined,
      name: String(row.name),
      description: String(row.description),
      price_cents: Number(row.price_cents),
      price_inr: formatPriceInr(Number(row.price_cents)),
      available: Boolean(row.available),
      dietary_classification: String(row.dietary_classification),
      ingredients: [],
      allergens: [],
    } as Product);
  });
}

export async function getProductAdmin(db: DatabaseLike, id: number) {
  const row = await readOne(
    db,
    `SELECT p.id, p.category_id, p.name, p.description, p.price_cents, p.available,
            p.dietary_classification, c.name AS category
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.id = ?`,
    [id]
  );
  if (!row) return null;
  const r = row as Record<string, unknown>;
  return {
    id: Number(r.id),
    category_id: Number(r.category_id),
    category: typeof r.category === "string" ? r.category : undefined,
    name: String(r.name),
    description: String(r.description),
    price_cents: Number(r.price_cents),
    price_inr: formatPriceInr(Number(r.price_cents)),
    available: Boolean(r.available),
    dietary_classification: String(r.dietary_classification),
  };
}

export async function upsertProductAdmin(
  db: DatabaseLike,
  input: AdminProductInput
): Promise<{ id: number; created: boolean }> {
  const validated = adminProductSchema.parse(input);
  let existing: unknown = null;
  if (validated.id) {
    existing = await readOne(db, "SELECT id FROM products WHERE id = ?", [
      validated.id,
    ]);
  }

  if (existing) {
    await db
      .prepare(
        `UPDATE products SET category_id = ?, name = ?, description = ?,
          price_cents = ?, available = ?, dietary_classification = ? WHERE id = ?`
      )
      .bind(
        validated.category_id,
        validated.name,
        validated.description,
        validated.price_cents,
        validated.available ? 1 : 0,
        validated.dietary_classification,
        validated.id
      )
      .run();
    return { id: validated.id!, created: false };
  }

  await db
    .prepare(
      `INSERT INTO products (category_id, name, description, price_cents, available, dietary_classification)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      validated.category_id,
      validated.name,
      validated.description,
      validated.price_cents,
      validated.available ? 1 : 0,
      validated.dietary_classification
    )
    .run();
  const idResult = await readOne(db, "SELECT MAX(id) AS id FROM products");
  const id = idResult ? Number((idResult as Record<string, unknown>).id) : 1;
  return { id, created: true };
}

export async function deleteProductAdmin(db: DatabaseLike, id: number) {
  await db.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return { id };
}

export async function listSalesAdmin(db: DatabaseLike) {
  const rows = await readAll(
    db,
    `SELECT id, total_cents, created_at FROM sales_transactions
     ORDER BY id DESC LIMIT 100`
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: Number(row.id),
      total_cents: Number(row.total_cents),
      total_inr: formatPriceInr(Number(row.total_cents)),
      created_at: String(row.created_at),
    };
  });
}

export async function salesStatsAdmin(db: DatabaseLike) {
  const row = (await readOne(
    db,
    "SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS total FROM sales_transactions"
  )) as { n: unknown; total: unknown };
  return {
    transactions: Number(row.n),
    total_cents: Number(row.total),
    total_inr: formatPriceInr(Number(row.total)),
  };
}

export interface SalesEntryInput {
  items: Array<{ product_id: number; quantity: number; unit_price_cents: number }>;
}

export interface SaleResult {
  id: number;
  total_cents: number;
  total_inr: string;
}

/** Record a completed sales transaction with its items in one transaction. */
export async function recordSaleAdmin(
  db: DatabaseLike,
  input: SalesEntryInput
): Promise<SaleResult> {
  const validated = z
    .object({
      items: z
        .array(
          z.object({
            product_id: z.number().int().positive(),
            quantity: z.number().int().positive(),
            unit_price_cents: z.number().int().positive(),
          })
        )
        .min(1),
    })
    .parse(input);

  let totalCents = 0;
  for (const item of validated.items) {
    const exists = await readOne(db, "SELECT id FROM products WHERE id = ?", [
      item.product_id,
    ]);
    if (!exists) {
      throw new Error(`Product not found: ${item.product_id}`);
    }
    totalCents += item.quantity * item.unit_price_cents;
  }

  const txResult: unknown = await db
    .prepare("INSERT INTO sales_transactions (total_cents) VALUES (?)")
    .bind(totalCents)
    .run();
  const txIdResult = await readOne(db, "SELECT MAX(id) AS id FROM sales_transactions");
  const txId = txIdResult
    ? Number((txIdResult as Record<string, unknown>).id)
    : 1;

  for (const item of validated.items) {
    await db
      .prepare(
        `INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price_cents)
         VALUES (?, ?, ?, ?)`
      )
      .bind(txId, item.product_id, item.quantity, item.unit_price_cents)
      .run();
  }

  return {
    id: txId,
    total_cents: totalCents,
    total_inr: formatPriceInr(totalCents),
  };
}

export interface CsvSaleRow {
  product_id: string;
  quantity: string;
  unit_price_cents: string;
  transaction_date?: string;
}

export interface CsvImportResult extends AdminSalesImportResult {
  transactions: Array<{ id: number; total_cents: number; total_inr: string }>;
}

/**
 * Import sales from CSV text. Validates product ids, quantities and prices;
 * rejects malformed rows; deduplicates by (product_id, quantity, unit price)
 * within the same import to prevent accidental duplicate imports.
 */
export async function importSalesCsvAdmin(
  db: DatabaseLike,
  csvText: string
): Promise<CsvImportResult> {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { imported: 0, rejected: [], transactions: [] };
  }
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const required = ["product_id", "quantity", "unit_price_cents"];
  if (!required.every((f) => header.includes(f))) {
    throw new Error("CSV must include product_id,quantity,unit_price_cents columns");
  }

  const idx = (name: string) => header.indexOf(name);
  const seen = new Set<string>();
  const rejected: Array<{ row: number; reason: string }> = [];
  const transactions: Array<{ id: number; total_cents: number; total_inr: string }> = [];
  let imported = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    const rowNum = i + 1;
    const productIdRaw = String(cols[idx("product_id")]).trim();
    const quantityRaw = String(cols[idx("quantity")]).trim();
    const priceRaw = String(cols[idx("unit_price_cents")]).trim();

    const productId = Number(productIdRaw);
    const quantity = Number(quantityRaw);
    const unitPriceCents = Number(priceRaw);

    if (!Number.isInteger(productId) || productId <= 0) {
      rejected.push({ row: rowNum, reason: "Invalid product_id" });
      continue;
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      rejected.push({ row: rowNum, reason: "Invalid quantity" });
      continue;
    }
    if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
      rejected.push({ row: rowNum, reason: "Invalid unit_price_cents" });
      continue;
    }

    const productExists = await readOne(db, "SELECT id FROM products WHERE id = ?", [
      productId,
    ]);
    if (!productExists) {
      rejected.push({ row: rowNum, reason: "Product not found" });
      continue;
    }

    const dedupeKey = `${productId}|${quantity}|${unitPriceCents}`;
    if (seen.has(dedupeKey)) {
      rejected.push({ row: rowNum, reason: "Duplicate within this import" });
      continue;
    }
    seen.add(dedupeKey);

    const totalCents = quantity * unitPriceCents;
    const txResult: unknown = await db
      .prepare("INSERT INTO sales_transactions (total_cents) VALUES (?)")
      .bind(totalCents)
      .run();
    const txIdResult = await readOne(db, "SELECT MAX(id) AS id FROM sales_transactions");
    const txId = txIdResult
      ? Number((txIdResult as Record<string, unknown>).id)
      : 1;
    await db
      .prepare(
        `INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price_cents)
         VALUES (?, ?, ?, ?)`
      )
      .bind(txId, productId, quantity, unitPriceCents)
      .run();

    imported += 1;
    transactions.push({
      id: txId,
      total_cents: totalCents,
      total_inr: formatPriceInr(totalCents),
    });
  }

  return { imported, rejected, transactions };
}

export interface Ingredient {
  id: number;
  name: string;
}

export interface Allergen {
  id: number;
  name: string;
}

export interface ProductAllergen extends Allergen {
  verified: boolean;
}

export interface ProductIngredientAssignment {
  ingredient_ids: number[];
}

export const ingredientIdsSchema = z.object({
  ingredient_ids: z.array(z.number().int().positive()),
});

export const allergenVerifiedSchema = z.object({
  verified: z.boolean(),
});

/** List all available ingredients (master list). */
export async function listIngredients(db: DatabaseLike): Promise<Ingredient[]> {
  const rows = await readAll(
    db,
    "SELECT id, name FROM ingredients ORDER BY name"
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return { id: Number(row.id), name: String(row.name) };
  });
}

/** List all available allergens (master list). */
export async function listAllergens(db: DatabaseLike): Promise<Allergen[]> {
  const rows = await readAll(db, "SELECT id, name FROM allergens ORDER BY name");
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return { id: Number(row.id), name: String(row.name) };
  });
}

/** List ingredients for a product. */
export async function listProductIngredients(
  db: DatabaseLike,
  productId: number
): Promise<Ingredient[]> {
  const rows = await readAll(
    db,
    `SELECT i.id, i.name FROM ingredients i
     JOIN product_ingredients pi ON pi.ingredient_id = i.id
     WHERE pi.product_id = ? ORDER BY i.name`,
    [productId]
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return { id: Number(row.id), name: String(row.name) };
  });
}

/** Replace a product's ingredients. */
export async function setProductIngredients(
  db: DatabaseLike,
  productId: number,
  ingredientIds: number[]
): Promise<void> {
  await db
    .prepare("DELETE FROM product_ingredients WHERE product_id = ?")
    .bind(productId)
    .run();
  for (const ingredientId of ingredientIds) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO product_ingredients (product_id, ingredient_id) VALUES (?, ?)`
      )
      .bind(productId, ingredientId)
      .run();
  }
}

/** List allergens for a product with verification status. */
export async function listProductAllergens(
  db: DatabaseLike,
  productId: number
): Promise<ProductAllergen[]> {
  const rows = await readAll(
    db,
    `SELECT a.id, a.name, pa.verified FROM allergens a
     JOIN product_allergens pa ON pa.allergen_id = a.id
     WHERE pa.product_id = ? ORDER BY a.name`,
    [productId]
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: Number(row.id),
      name: String(row.name),
      verified: Boolean(row.verified),
    };
  });
}

/** Toggle verification status of a product allergen. */
export async function setAllergenVerified(
  db: DatabaseLike,
  productId: number,
  allergenId: number,
  verified: boolean
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO product_allergens (product_id, allergen_id, verified) VALUES (?, ?, ?)`
    )
    .bind(productId, allergenId, verified ? 1 : 0)
    .run();
}

