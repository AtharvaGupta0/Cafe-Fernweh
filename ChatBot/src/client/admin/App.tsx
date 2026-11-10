/**
 * Café Fernweh admin dashboard.
 *
 * Single-page React admin interface for menu management and sales.
 * All calls go to the same-origin backend (HttpOnly session cookie is sent
 * automatically by the browser). Protected by admin session auth + CSRF on
 * state-changing endpoints.
 */

import { useState, useEffect } from "react";

type Product = {
  id: number;
  category_id: number;
  category: string | undefined;
  name: string;
  description: string;
  price_cents: number;
  price_inr: string;
  available: boolean;
  dietary_classification: string;
};

type Ingredient = { id: number; name: string };
type Allergen = { id: number; name: string };
type ProductAllergen = Allergen & { verified: boolean };

type Sale = {
  id: number;
  total_cents: number;
  total_inr: string;
  created_at: string;
};
type SalesStats = {
  transactions: number;
  total_cents: number;
  total_inr: string;
};

const API = "/admin";

function api(path: string, body?: unknown, method = "GET") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (body !== undefined && method !== "GET") {
    headers["X-CSRF-Token"] = document.cookie
      .split("; ")
      .find((c) => c.trimStart().startsWith("csrf_token="))
      ?.split("=")[1] ?? "";
  }
  return fetch(`${API}${path}`, {
    method,
    headers,
    credentials: "include",
    ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
}

function money(cents: number): string {
  return `₹${(cents / 100).toFixed(2)}`;
}

export default function App() {
  const [view, setView] = useState<"login" | "menu" | "sales">("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Menu view state
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [allergens, setAllergens] = useState<Allergen[]>([]);
  const [search, setSearch] = useState("");
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [productIngredients, setProductIngredients] = useState<number[]>([]);
  const [productAllergens, setProductAllergens] = useState<ProductAllergen[]>([]);
  const [newProduct, setNewProduct] = useState({
    category_id: 1,
    name: "",
    description: "",
    price_cents: 5000,
    available: true,
    dietary_classification: "none" as const,
  });

  // Sales view state
  const [sales, setSales] = useState<Sale[]>([]);
  const [stats, setStats] = useState<SalesStats | null>(null);
  const [newSale, setNewSale] = useState({ product_id: 1, quantity: 1, unit_price_cents: 9000 });
  const [csvText, setCsvText] = useState("");
  const [importResult, setImportResult] = useState<{ imported: number; rejected: Array<{ row: number; reason: string }> } | null>(null);

  useEffect(() => {
    checkSession();
  }, []);

  async function checkSession() {
    setLoading(true);
    try {
      const res = await api("/sales");
      if (res.ok) {
        setView("menu");
      } else {
        setView("login");
      }
    } catch {
      setView("login");
    } finally {
      setLoading(false);
    }
  }

  async function login(token: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await api("/login", { token }, "POST");
      if (!res.ok) throw new Error("Invalid admin token.");
      setView("menu");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    setLoading(true);
    try {
      await api("/logout", undefined, "POST");
    } finally {
      setView("login");
      setLoading(false);
    }
  }

  // ---------- Menu ----------
  async function loadMenu() {
    setLoading(true);
    try {
      const res = await api("/menu");
      const data = (await res.json()) as any;
      setProducts(data?.products || []);
    } finally {
      setLoading(false);
    }
  }

  async function loadReferenceData() {
    const [ingRes, allRes] = await Promise.all([
      api("/ingredients"),
      api("/allergens"),
    ]);
    if (ingRes.ok) setIngredients(((await ingRes.json()) as any).ingredients || []);
    if (allRes.ok) setAllergens(((await allRes.json()) as any).allergens || []);
  }

  async function openProductEditor(product: Product) {
    setEditProduct(product);
    const [ingRes, allRes] = await Promise.all([
      api(`/menu/${product.id}/ingredients`),
      api(`/menu/${product.id}/allergens`),
    ]);
    if (ingRes.ok) setProductIngredients(((await ingRes.json()) as any).ingredients.map((i: Ingredient) => i.id));
    if (allRes.ok) setProductAllergens((await allRes.json()) as any);
  }

  async function saveProduct() {
    const p = editProduct!;
    const body = {
      id: p.id,
      category_id: p.category_id,
      name: p.name,
      description: p.description,
      price_cents: p.price_cents,
      available: p.available,
      dietary_classification: p.dietary_classification,
    };
    const res = await api("/menu", body, "PUT");
    if (res.ok) {
      setEditProduct(null);
      loadMenu();
    } else {
      setError("Failed to save product.");
    }
  }

  async function createProduct() {
    const res = await api("/menu", newProduct, "POST");
    if (res.ok) {
      setNewProduct({ category_id: 1, name: "", description: "", price_cents: 5000, available: true, dietary_classification: "none" });
      loadMenu();
    } else {
      setError("Failed to create product.");
    }
  }

  async function deleteProduct(id: number) {
    if (!confirm("Deactivate this product?")) return;
    const res = await api(`/menu/${id}`, undefined, "DELETE");
    if (res.ok) loadMenu();
    else setError("Failed to delete product.");
  }

  async function saveIngredients() {
    if (!editProduct) return;
    const res = await api(`/menu/${editProduct.id}/ingredients`, { ingredient_ids: productIngredients }, "PUT");
    if (!res.ok) setError("Failed to update ingredients.");
  }

  async function toggleAllergen(allergenId: number) {
    if (!editProduct) return;
    const next = !productAllergens.find((a) => a.id === allergenId)?.verified;
    setProductAllergens((prev) =>
      prev.map((a) => (a.id === allergenId ? { ...a, verified: next } : a))
    );
    const res = await api(`/menu/${editProduct.id}/allergens/${allergenId}/verified`, { verified: next }, "PUT");
    if (!res.ok) {
      setError("Failed to update allergen verification.");
      loadMenu(); // revert UI
    }
  }

  // ---------- Sales ----------
  async function loadSales() {
    setLoading(true);
    try {
      const [listRes, statsRes] = await Promise.all([api("/sales"), api("/sales")]);
      // NOTE: /admin/sales returns both list and stats in one response.
      const data = (await (await api("/sales")).json()) as any;
      setSales(data.list || []);
      setStats(data.stats || null);
    } finally {
      setLoading(false);
    }
  }

  async function recordSale() {
    const res = await api("/sales", { items: [newSale] }, "POST");
    if (res.ok) {
      setNewSale({ product_id: 1, quantity: 1, unit_price_cents: 9000 });
      loadSales();
    } else {
      setError("Failed to record sale.");
    }
  }

  async function importCsv() {
    const res = await api("/sales/import", { csv: csvText }, "POST");
    const data = (await res.json()) as any;
    setImportResult(data);
    if (res.ok) loadSales();
  }

  const filteredProducts = products.filter(
    (p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.category?.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="p-10 text-center">
        <p className="text-brown-700">Loading…</p>
      </div>
    );
  }

  if (view === "login") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brown-50">
        <div className="bg-white p-8 rounded-xl shadow border border-brown-200 w-full max-w-md">
          <h1 className="text-brown-900 font-serif font-semibold text-2xl mb-6">Café Fernweh Admin</h1>
          {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
          <label className="block text-sm font-medium mb-1">Admin token</label>
          <input
            type="password"
            className="w-full p-2 border border-brown-300 rounded mb-4"
            onChange={(e) => login(e.target.value)}
            placeholder="Enter admin token"
          />
          <button
            className="w-full bg-brown-600 text-white px-4 py-2 rounded hover:bg-brown-700 disabled:opacity-50"
            disabled={loading}
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brown-50">
      <nav className="bg-brown-700 text-white px-6 py-4 flex justify-between items-center">
        <div className="font-serif font-semibold text-xl">Café Fernweh Admin</div>
        <div className="flex gap-4">
          <button
            onClick={() => setView("menu")}
            className={`px-3 py-2 rounded ${view === "menu" ? "bg-brown-600" : "bg-brown-600/30 hover:bg-brown-600/50"}`}
          >
            Menu
          </button>
          <button
            onClick={() => setView("sales")}
            className={`px-3 py-2 rounded ${view === "sales" ? "bg-brown-600" : "bg-brown-600/30 hover:bg-brown-600/50"}`}
          >
            Sales
          </button>
          <button onClick={logout} className="text-brown-200 hover:text-white underline">
            Sign out
          </button>
        </div>
      </nav>

      {error && (
        <div className="p-4 max-w-2xl mx-auto bg-red-50 border border-red-200 text-red-700 rounded text-sm">
          {error}
        </div>
      )}

      <main className="max-w-5xl mx-auto p-6">
        {view === "menu" ? (
          <>
            <div className="flex justify-between items-end mb-6">
              <div>
                <h2 className="text-brown-900 font-serif font-semibold text-xl mb-1">Menu Management</h2>
                <p className="text-brown-500 text-sm">View, add and edit products.</p>
              </div>
              <button
                onClick={() => {
                  setEditProduct(null);
                  setNewProduct({ category_id: 1, name: "", description: "", price_cents: 5000, available: true, dietary_classification: "none" });
                }}
                className="bg-brown-600 text-white px-4 py-2 rounded hover:bg-brown-700"
              >
                Add product
              </button>
            </div>

            <div className="mb-4">
              <input
                className="w-full p-2 border border-brown-300 rounded"
                placeholder="Search products…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <table className="w-full border border-brown-200 rounded bg-white">
              <thead>
                <tr className="bg-brown-100">
                  <th className="p-2 text-left">Name</th>
                  <th className="p-2 text-left">Category</th>
                  <th className="p-2 text-right">Price</th>
                  <th className="p-2 text-center">Available</th>
                  <th className="p-2 text-left">Dietary</th>
                  <th className="p-2 text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((p) => (
                  <tr key={p.id} className="border-b border-brown-100">
                    <td className="p-2">{p.name}</td>
                    <td className="p-2">{p.category}</td>
                    <td className="p-2 text-right">{money(p.price_cents)}</td>
                    <td className="p-2 text-center">{p.available ? "Yes" : "No"}</td>
                    <td className="p-2">{p.dietary_classification}</td>
                    <td className="p-2 text-center">
                      <button
                        onClick={() => openProductEditor(p)}
                        className="text-brown-600 hover:underline text-sm"
                      >
                        Edit
                      </button>
                      {p.available ? (
                        <button
                          onClick={() => deleteProduct(p.id)}
                          className="ml-2 text-red-600 hover:underline text-sm"
                        >
                          Deactivate
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {editProduct && (
              <div className="mt-8 bg-white p-6 rounded border border-brown-200">
                <h3 className="text-brown-900 font-semibold mb-4">Edit {editProduct.name}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Name</label>
                    <input
                      className="w-full p-2 border border-brown-300 rounded"
                      value={editProduct.name}
                      onChange={(e) => setEditProduct({ ...editProduct, name: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Price (paise)</label>
                    <input
                      type="number"
                      className="w-full p-2 border border-brown-300 rounded"
                      value={editProduct.price_cents}
                      onChange={(e) =>
                        setEditProduct({ ...editProduct, price_cents: Number(e.target.value) || 0 })
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Dietary</label>
                    <select
                      className="w-full p-2 border border-brown-300 rounded"
                      value={editProduct.dietary_classification}
                      onChange={(e) =>
                        setEditProduct({ ...editProduct, dietary_classification: e.target.value as any })
                      }
                    >
                      <option>none</option>
                      <option>vegan</option>
                      <option>vegetarian</option>
                      <option>dairy_free</option>
                      <option>lactose_free</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <label className="mr-2 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={editProduct.available}
                          onChange={(e) =>
                            setEditProduct({ ...editProduct, available: e.target.checked })
                          }
                        />
                        <span>Available</span>
                      </label>
                    </label>
                  </div>
                </div>
                <div className="mt-6">
                  <h4 className="text-brown-800 font-medium mb-2">Ingredients</h4>
                  <div className="flex flex-wrap gap-2 mb-4">
                    {ingredients.map((ing) => (
                      <button
                        key={ing.id}
                        onClick={() => {
                          if (productIngredients.includes(ing.id)) {
                            setProductIngredients(productIngredients.filter((i) => i !== ing.id));
                          } else {
                            setProductIngredients([...productIngredients, ing.id]);
                          }
                        }}
                        className={`px-3 py-1 rounded text-sm border ${
                          productIngredients.includes(ing.id)
                            ? "bg-brown-600 text-white"
                            : "bg-white border-brown-300 text-brown-700"
                        }`}
                      >
                        {ing.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-6">
                  <h4 className="text-brown-800 font-medium mb-2">Allergens (verification)</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {productAllergens.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 p-2 border rounded bg-white">
                        <input
                          type="checkbox"
                          checked={a.verified}
                          onChange={() => toggleAllergen(a.id)}
                        />
                        <span className={a.verified ? "text-brown-700" : "text-brown-400"}>
                          {a.name} {a.verified ? "✓ verified" : "unverified"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-6 flex gap-2">
                  <button
                    onClick={() => {
                      saveIngredients();
                      saveProduct();
                    }}
                    className="bg-brown-600 text-white px-4 py-2 rounded hover:bg-brown-700"
                  >
                    Save changes
                  </button>
                  <button
                    onClick={() => setEditProduct(null)}
                    className="border border-brown-300 text-brown-700 px-4 py-2 rounded hover:bg-brown-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="mt-8 bg-white p-6 rounded border border-brown-200">
              <h3 className="text-brown-900 font-semibold mb-4">New product</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Category id</label>
                  <input
                    type="number"
                    className="w-full p-2 border border-brown-300 rounded"
                    value={newProduct.category_id}
                    onChange={(e) => setNewProduct({ ...newProduct, category_id: Number(e.target.value) || 1 })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Name</label>
                  <input
                    className="w-full p-2 border border-brown-300 rounded"
                    value={newProduct.name}
                    onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Price (paise)</label>
                  <input
                    type="number"
                    className="w-full p-2 border border-brown-300 rounded"
                    value={newProduct.price_cents}
                    onChange={(e) => setNewProduct({ ...newProduct, price_cents: Number(e.target.value) || 0 })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Description</label>
                  <input
                    className="w-full p-2 border border-brown-300 rounded"
                    value={newProduct.description}
                    onChange={(e) => setNewProduct({ ...newProduct, description: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Dietary</label>
                  <select
                    className="w-full p-2 border border-brown-300 rounded"
                    value={newProduct.dietary_classification}
                    onChange={(e) =>
                      setNewProduct({ ...newProduct, dietary_classification: e.target.value as any })
                    }
                  >
                    <option>none</option>
                    <option>vegan</option>
                    <option>vegetarian</option>
                    <option>dairy_free</option>
                    <option>lactose_free</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <label className="mr-2 text-sm">
                    <input
                      type="checkbox"
                      checked={newProduct.available}
                      onChange={(e) => setNewProduct({ ...newProduct, available: e.target.checked })}
                    />
                    Available
                  </label>
                </div>
                <div className="col-span-3">
                  <button onClick={createProduct} className="bg-brown-600 text-white px-4 py-2 rounded hover:bg-brown-700">
                    Create product
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-between items-end mb-6">
              <div>
                <h2 className="text-brown-900 font-serif font-semibold text-xl mb-1">Sales</h2>
                <p className="text-brown-500 text-sm">Record sales, import CSV, view statistics.</p>
              </div>
            </div>

            {stats && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <div className="bg-white p-4 rounded border border-brown-200">
                  <div className="text-brown-500 text-xs">Total transactions</div>
                  <div className="text-brown-900 font-semibold">{stats.transactions}</div>
                </div>
                <div className="bg-white p-4 rounded border border-brown-200">
                  <div className="text-brown-500 text-xs">Total revenue</div>
                  <div className="text-brown-900 font-semibold">{stats.total_inr}</div>
                </div>
                <div className="bg-white p-4 rounded border border-brown-200">
                  <div className="text-brown-500 text-xs">Avg order value</div>
                  <div className="text-brown-900 font-semibold">{stats.total_cents > 0 ? money(Math.round(stats.total_cents / stats.transactions)) : "₹0.00"}</div>
                </div>
              </div>
            )}

            <div className="mb-6 bg-white p-6 rounded border border-brown-200">
              <h3 className="text-brown-900 font-semibold mb-4">Record sale</h3>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Product id</label>
                  <input
                    type="number"
                    className="w-full p-2 border border-brown-300 rounded"
                    value={newSale.product_id}
                    onChange={(e) => setNewSale({ ...newSale, product_id: Number(e.target.value) || 1 })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Quantity</label>
                  <input
                    type="number"
                    className="w-full p-2 border border-brown-300 rounded"
                    value={newSale.quantity}
                    onChange={(e) => setNewSale({ ...newSale, quantity: Number(e.target.value) || 1 })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Unit price (paise)</label>
                  <input
                    type="number"
                    className="w-full p-2 border border-brown-300 rounded"
                    value={newSale.unit_price_cents}
                    onChange={(e) => setNewSale({ ...newSale, unit_price_cents: Number(e.target.value) || 0 })}
                  />
                </div>
                <div className="flex items-end">
                  <button onClick={recordSale} className="bg-brown-600 text-white px-4 py-2 rounded hover:bg-brown-700">
                    Record
                  </button>
                </div>
              </div>
            </div>

            <div className="mb-6 bg-white p-6 rounded border border-brown-200">
              <h3 className="text-brown-900 font-semibold mb-4">Import sales (CSV)</h3>
              <p className="text-sm text-brown-500 mb-3">
                Columns: product_id,quantity,unit_price_cents
              </p>
              <textarea
                className="w-full p-2 border border-brown-300 rounded mb-3"
                rows={4}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="product_id,quantity,unit_price_cents\n1,2,9000\n17,1,5000"
              />
              <button
                onClick={importCsv}
                className="bg-brown-600 text-white px-4 py-2 rounded hover:bg-brown-700 disabled:opacity-50"
                disabled={!csvText.trim()}
              >
                Import
              </button>
              {importResult && (
                <div className="mt-3 p-3 rounded bg-brown-50 text-sm">
                  Imported: <span className="font-semibold">{importResult.imported}</span>{" "}
                  Rejected:{" "}
                  <span className="font-semibold text-red-600">{importResult.rejected.length}</span>
                  {importResult.rejected.slice(0, 5).map((r) => (
                    <div key={r.row} className="text-xs text-brown-600">
                      Row {r.row}: {r.reason}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded border border-brown-200">
              <h3 className="text-brown-900 font-semibold p-4 border-b border-brown-200">Recent sales</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-brown-50">
                    <th className="p-2 text-left">Id</th>
                    <th className="p-2 text-left">Revenue</th>
                    <th className="p-2 text-left">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.slice(0, 10).map((s) => (
                    <tr key={s.id} className="border-b border-brown-100">
                      <td className="p-2">{s.id}</td>
                      <td className="p-2 text-right">{s.total_inr}</td>
                      <td className="p-2">{s.created_at}</td>
                    </tr>
                  ))}
                  {sales.length === 0 && (
                    <tr><td colSpan={3} className="p-4 text-center text-brown-400">No sales recorded.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
