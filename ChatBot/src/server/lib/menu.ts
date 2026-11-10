import { DatabaseLike } from "@shared/types";
import { productSchema, type Product, type DietaryRestriction } from "@shared/schema";
import { readAll, readOne, formatPriceInr } from "./db";

/** Allergen names that indicate dairy, for lactose-free / dairy-free checks. */
const DAIRY_ALLERGENS = ["milk"];
/** Allergen names that indicate nuts, for nut-free checks. */
const NUT_ALLERGENS = ["peanuts", "almonds", "nuts"];
/** Allergen names that indicate gluten, for gluten-free checks. */
const GLUTEN_ALLERGENS = ["gluten (wheat)", "gluten"];
/** Allergen names that indicate animal products, for vegan checks. */
const ANIMAL_ALLERGENS = ["milk", "eggs", "honey", "fish"];

async function toProduct(db: DatabaseLike, row: unknown): Promise<Product | null> {
  if (!row) return null;
  const id = Number((row as { id: unknown }).id);
  const category = (row as { category?: unknown }).category;
  const ingredients: string[] = (
    await readAll(
      db,
      "SELECT i.name FROM ingredients i JOIN product_ingredients pi ON pi.ingredient_id = i.id WHERE pi.product_id = ?",
      [id]
    )
  ).map((r) => String((r as { name: unknown }).name));
  const allergens = (
    await readAll(
      db,
      "SELECT a.name, pa.verified FROM allergens a JOIN product_allergens pa ON pa.allergen_id = a.id WHERE pa.product_id = ?",
      [id]
    )
  ).map((r) => ({
    name: String((r as { name: unknown }).name),
    verified: Boolean((r as { verified: unknown }).verified),
  }));
  const product = {
    id,
    category_id: Number((row as { category_id: unknown }).category_id),
    category: typeof category === "string" ? category : undefined,
    name: String((row as { name: unknown }).name),
    description: String((row as { description: unknown }).description),
    price_cents: Number((row as { price_cents: unknown }).price_cents),
    price_inr: formatPriceInr(Number((row as { price_cents: unknown }).price_cents)),
    available: Boolean((row as { available: unknown }).available),
    dietary_classification: String((row as { dietary_classification: unknown }).dietary_classification),
    ingredients,
    allergens,
  };
  return productSchema.parse(product);
}

function baseProductsSql(): string {
  return `
    SELECT p.id, p.category_id, p.name, p.description, p.price_cents, p.available,
           p.dietary_classification, c.name AS category
    FROM products p
    JOIN categories c ON c.id = p.category_id
  `;
}

/** Search products by name or description. */
export async function searchProducts(
  db: DatabaseLike,
  args: { query: string; limit?: number }
): Promise<Product[]> {
  const q = `%${String(args.query)}%`;
  const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50);
  const rows = await readAll(
    db,
    `${baseProductsSql()}
     WHERE p.name LIKE ? OR p.description LIKE ?
     ORDER BY p.id
     LIMIT ?`,
    [q, q, limit]
  );
  const products = await Promise.all(rows.map((r) => toProduct(db, r)));
  return products.filter((p): p is Product => p !== null);
}

/** Retrieve a single product by id. */
export async function getProduct(db: DatabaseLike, id: number): Promise<Product | null> {
  const row = await readOne(
    db,
    `${baseProductsSql()} WHERE p.id = ?`,
    [id]
  );
  return await toProduct(db, row);
}

/** Check availability of a product. */
export async function checkAvailability(
  db: DatabaseLike,
  id: number
): Promise<{ available: boolean; product: Product | null }> {
  const product = await getProduct(db, id);
  return { available: Boolean(product?.available), product };
}

/**
 * Evaluate a dietary restriction for a product using only verified evidence.
 *
 * Returns:
 *  - "safe":   verified evidence supports the restriction.
 *  - "unsafe": verified evidence shows the restriction is violated.
 *  - "unknown": insufficient verified evidence (never inferred safe).
 *
 * Unknown allergen information is treated as unknown. Cross-contact is never
 * ruled out unless the kitchen has verified otherwise, so no item is labelled
 * allergen-safe without verified evidence.
 */
export async function evaluateDietary(
  db: DatabaseLike,
  id: number,
  restriction: DietaryRestriction
): Promise<{
  status: "safe" | "unsafe" | "unknown";
  reason: string;
  product: Product | null;
}> {
  const product = await getProduct(db, id);
  if (!product) {
    return { status: "unknown", reason: "Product not found.", product: null };
  }

  const verifiedAllergens = product.allergens
    .filter((a) => a.verified)
    .map((a) => a.name.toLowerCase());
  const hasVerified = (names: string[]) =>
    names.some((n) => verifiedAllergens.includes(n.toLowerCase()));
  const classification = product.dietary_classification.toLowerCase();

  switch (restriction) {
    case "vegan":
      if (classification === "vegan") {
        return { status: "safe", reason: "Kitchen-classified as vegan.", product };
      }
      if (hasVerified(ANIMAL_ALLERGENS)) {
        return {
          status: "unsafe",
          reason: "Contains verified animal-derived allergen(s).",
          product,
        };
      }
      return {
        status: "unknown",
        reason:
          "Not kitchen-classified as vegan and allergen data is insufficient to confirm.",
        product,
      };
    case "dairy_free":
      if (classification === "dairy_free" || classification === "vegan") {
        return { status: "safe", reason: "Kitchen-classified as dairy-free or vegan.", product };
      }
      if (hasVerified(DAIRY_ALLERGENS)) {
        return {
          status: "unsafe",
          reason: "Contains verified milk/dairy.",
          product,
        };
      }
      return {
        status: "unknown",
        reason:
          "Not kitchen-classified as dairy-free and milk allergen data is insufficient to confirm.",
        product,
      };
    case "lactose_free":
      if (classification === "lactose_free" || classification === "vegan") {
        return {
          status: "safe",
          reason: "Kitchen-classified as lactose-free or vegan.",
          product,
        };
      }
      if (hasVerified(DAIRY_ALLERGENS)) {
        return {
          status: "unsafe",
          reason: "Contains verified milk (lactose present).",
          product,
        };
      }
      return {
        status: "unknown",
        reason:
          "Not kitchen-classified as lactose-free and milk allergen data is insufficient to confirm.",
        product,
      };
    case "nut_free":
      if (hasVerified(NUT_ALLERGENS)) {
        return {
          status: "unsafe",
          reason: "Contains verified nut allergen(s).",
          product,
        };
      }
      return {
        status: "unknown",
        reason: "Nut allergen data is insufficient to confirm (cross-contact possible).",
        product,
      };
    case "gluten_free":
      if (hasVerified(GLUTEN_ALLERGENS)) {
        return {
          status: "unsafe",
          reason: "Contains verified gluten.",
          product,
        };
      }
      return {
        status: "unknown",
        reason: "Gluten data is insufficient to confirm (cross-contact possible).",
        product,
      };
    case "vegetarian":
      if (classification === "vegetarian" || classification === "vegan") {
        return { status: "safe", reason: "Kitchen-classified as vegetarian or vegan.", product };
      }
      if (hasVerified(["meat", "fish", "gelatin"])) {
        return { status: "unsafe", reason: "Contains verified non-vegetarian ingredient.", product };
      }
      return {
        status: "unknown",
        reason:
          "Not kitchen-classified as vegetarian; animal-derivative data is insufficient.",
        product,
      };
  }
}

interface FilterArgs {
  category?: string;
  min_price_cents?: number;
  max_price_cents?: number;
  dietary?: DietaryRestriction;
  allergen?: string; // exclude products with this verified allergen
  available?: boolean;
  limit?: number;
}

/** Filter products deterministically using parameterised SQL. */
export async function filterProducts(db: DatabaseLike, args: FilterArgs): Promise<Product[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (args.category) {
    clauses.push("LOWER(c.name) = LOWER(?)");
    params.push(args.category);
  }
  if (args.min_price_cents != null) {
    clauses.push("p.price_cents >= ?");
    params.push(args.min_price_cents);
  }
  if (args.max_price_cents != null) {
    clauses.push("p.price_cents <= ?");
    params.push(args.max_price_cents);
  }
  if (args.dietary) {
    // Vegan products also satisfy dairy-free, lactose-free and vegetarian,
    // mirroring evaluateDietary() so the two operations stay consistent.
    const d = String(args.dietary).toLowerCase();
    const allowed = {
      vegan: ["vegan"],
      dairy_free: ["dairy_free", "vegan"],
      lactose_free: ["lactose_free", "vegan"],
      vegetarian: ["vegetarian", "vegan"],
    }[d] ?? [d];
    clauses.push(`LOWER(p.dietary_classification) IN (${allowed.map(() => "?").join(",")})`);
    params.push(...allowed);
  }
  if (args.available !== undefined) {
    clauses.push("p.available = ?");
    params.push(args.available ? 1 : 0);
  }
  if (args.allergen) {
    clauses.push(
      `NOT EXISTS (
        SELECT 1 FROM product_allergens pa
        JOIN allergens a ON a.id = pa.allergen_id
        WHERE pa.product_id = p.id AND LOWER(a.name) = LOWER(?) AND pa.verified = 1
      )`
    );
    params.push(args.allergen);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 100);
  const rows = await readAll(
    db,
    `${baseProductsSql()} ${where} ORDER BY p.id LIMIT ?`,
    [...params, limit]
  );
  const products = await Promise.all(rows.map((r) => toProduct(db, r)));
  return products.filter((p): p is Product => p !== null);
}

interface BestsellerItem {
  product: Product;
  units_sold: number;
  revenue_cents: number;
}

/** Bestsellers ranked by units sold from recorded transactions (not arbitrary scores). */
export async function getBestsellers(
  db: DatabaseLike,
  limit = 10
): Promise<BestsellerItem[]> {
  const lim = Math.min(Math.max(Number(limit), 1), 50);
  const rows = await readAll(
    db,
    `
    SELECT p.id, p.category_id, p.name, p.description, p.price_cents, p.available,
           p.dietary_classification, c.name AS category,
           SUM(ti.quantity) AS units_sold,
           SUM(ti.quantity * ti.unit_price_cents) AS revenue_cents
    FROM transaction_items ti
    JOIN products p ON p.id = ti.product_id
    JOIN categories c ON c.id = p.category_id
    GROUP BY p.id
    ORDER BY units_sold DESC, revenue_cents DESC
    LIMIT ?
    `,
    [lim]
  );
  const items = await Promise.all(
    rows.map(async (r) => {
      const row = r as Record<string, unknown>;
      const product = await toProduct(db, {
        id: Number(row.id),
        category_id: Number(row.category_id),
        category: typeof row.category === "string" ? row.category : undefined,
        name: String(row.name),
        description: String(row.description),
        price_cents: Number(row.price_cents),
        available: Boolean(row.available),
        dietary_classification: String(row.dietary_classification),
      });
      if (!product) return null;
      return {
        product,
        units_sold: Number(row.units_sold),
        revenue_cents: Number(row.revenue_cents),
      };
    })
  );
  return items.filter((i): i is BestsellerItem => i !== null);
}

/** Sales statistics calculated from recorded transactions. */
export async function getSalesStats(db: DatabaseLike) {
  const row = (await readOne(
    db,
    "SELECT COUNT(*) AS total_transactions, COALESCE(SUM(total_cents), 0) AS total_revenue_cents FROM sales_transactions"
  )) as { total_transactions: unknown; total_revenue_cents: unknown };
  const totalTransactions = Number(row.total_transactions);
  const totalRevenueCents = Number(row.total_revenue_cents);
  return {
    total_transactions: totalTransactions,
    total_revenue_cents: totalRevenueCents,
    total_revenue_inr: formatPriceInr(totalRevenueCents),
    average_order_value_inr:
      totalTransactions > 0 ? formatPriceInr(totalRevenueCents / totalTransactions) : "₹0.00",
  };
}

interface RecommendationConstraints {
  category?: string;
  max_price_cents?: number;
  dietary?: DietaryRestriction;
  allergen_exclude: string[];
  taste?: string;
  temperature?: string;
}

/** Generate eligible recommendation candidates; taste/temperature are hints for the model to explain. */
export async function getRecommendationCandidates(
  db: DatabaseLike,
  args: { constraints: RecommendationConstraints; limit?: number }
): Promise<Product[]> {
  return filterProducts(db, {
    category: args.constraints.category,
    max_price_cents: args.constraints.max_price_cents,
    dietary: args.constraints.dietary,
    allergen: args.constraints.allergen_exclude[0] || undefined,
    available: true,
    limit: args.limit ?? 20,
  });
}
