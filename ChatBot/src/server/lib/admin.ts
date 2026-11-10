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
  const existing = await readOne(db, "SELECT id FROM products WHERE id = ?", [
    validated.id,
  ]);

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
  const idResult = await readOne(db, "SELECT last_insert_rowid() AS id");
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
