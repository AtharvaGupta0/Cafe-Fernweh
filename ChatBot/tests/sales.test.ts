import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers";
import {
  recordSaleAdmin,
  importSalesCsvAdmin,
  salesStatsAdmin,
  listProductsAdmin,
  upsertProductAdmin,
} from "../src/server/lib/admin";

describe("sales management", () => {
  it("records a completed sale and updates stats", async () => {
    const db = await createTestDb();
    const result = await recordSaleAdmin(db, {
      items: [
        { product_id: 1, quantity: 2, unit_price_cents: 9000 },
        { product_id: 17, quantity: 1, unit_price_cents: 5000 },
      ],
    });
    expect(result.total_cents).toBe(23000);
    expect(result.total_inr).toBe("₹230.00");
    expect(result.id).toBeGreaterThan(0);

    const stats = await salesStatsAdmin(db);
    expect(stats.transactions).toBe(29); // 28 seed + 1 new
    expect(stats.total_cents).toBe(607000 + 23000);
  });

  it("rejects sales with unknown product ids", async () => {
    const db = await createTestDb();
    await expect(
      recordSaleAdmin(db, {
        items: [{ product_id: 99999, quantity: 1, unit_price_cents: 1000 }],
      })
    ).rejects.toThrow();
  });

  it("imports valid CSV sales and rejects malformed rows", async () => {
    const db = await createTestDb();
    const csv = `product_id,quantity,unit_price_cents
1,2,9000
17,1,5000
99999,1,1000
1,0,9000
abc,1,1000
`;
    const result = await importSalesCsvAdmin(db, csv);
    expect(result.imported).toBe(2);
    expect(result.rejected.length).toBe(3);
    expect(result.rejected.map((r) => r.reason)).toContain("Product not found");
    expect(result.rejected.map((r) => r.reason)).toContain("Invalid quantity");
    expect(result.rejected.map((r) => r.reason)).toContain("Invalid product_id");
  });

  it("deduplicates duplicate rows within one import", async () => {
    const db = await createTestDb();
    const csv = `product_id,quantity,unit_price_cents
1,2,9000
1,2,9000
`;
    const result = await importSalesCsvAdmin(db, csv);
    expect(result.imported).toBe(1);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]!.reason).toBe("Duplicate within this import");
  });

  it("rejects CSV missing required columns", async () => {
    const db = await createTestDb();
    await expect(
      importSalesCsvAdmin(db, "name,price\nEspresso,9000\n")
    ).rejects.toThrow();
  });

  it("upsert product creates and updates records", async () => {
    const db = await createTestDb();
    const created = await upsertProductAdmin(db, {
      category_id: 1,
      name: "Test Coffee",
      description: "A test drink.",
      price_cents: 5000,
      available: true,
      dietary_classification: "vegan",
    });
    expect(created.created).toBe(true);
    expect(created.id).toBeGreaterThan(0);

    const updated = await upsertProductAdmin(db, {
      id: created.id,
      category_id: 1,
      name: "Test Coffee Renamed",
      description: "Renamed.",
      price_cents: 6000,
      available: false,
      dietary_classification: "none",
    });
    expect(updated.created).toBe(false);
    expect(updated.id).toBe(created.id);

    const products = await listProductsAdmin(db);
    const found = products.find((p) => p.id === created.id);
    expect(found?.name).toBe("Test Coffee Renamed");
    expect(found?.available).toBe(false);
  });
});
