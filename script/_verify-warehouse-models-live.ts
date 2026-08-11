/**
 * Live end-to-end verification of the warehouse model layer (D32–D35).
 *
 * Drives the real HTTP API with a real logged-in session — the model picker,
 * the variant expansion, batched variant details, autocomplete, placement,
 * mid-count registration with a rack code, the catalogue CSV, and the
 * un-grouping delete. Creates a throwaway super admin and removes everything it
 * made, so Dima opens a clean tab.
 *
 *   npx tsx --env-file=.env script/_verify-warehouse-models-live.ts
 *   VERIFY_BASE=http://localhost:5099 npx tsx --env-file=.env script/_verify-warehouse-models-live.ts
 *
 * 🔴 Defaults to LOCALHOST, not prod: these routes are not deployed yet, and a
 * verification that silently passes against a server without the code is worse
 * than no verification.
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.VERIFY_BASE || "http://localhost:5099";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const EMAIL = `wh-verify-${Date.now()}@example.invalid`;
const PASSWORD = "Verify!" + Math.random().toString(36).slice(2, 10);
let cookie = "";
let userId: number | null = null;
const madeItemIds: number[] = [];
const madeModelIds: number[] = [];

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* CSV and errors are not JSON */ }
  return { status: r.status, json, text };
};

try {
  // ── Throwaway super admin ────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 10);
  // 🔴 public.users, not Supabase's auth.users — they BOTH exist in this
  // database and only the latter has is_super_admin. Here the role IS the
  // grant: server/auth.ts short-circuits requireTab for role 'super_admin'.
  const ins = await pool.query(
    `INSERT INTO users (email, password, first_name, last_name, role, active)
     VALUES ($1, $2, 'Warehouse', 'Verify', 'super_admin', true) RETURNING id`,
    [EMAIL, hash],
  );
  userId = ins.rows[0].id;
  console.log(`\nThrowaway admin ${EMAIL} (id ${userId})\n`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  ok("logged in", login.status === 200 && !!cookie, `status ${login.status}`);

  // ── The model layer ──────────────────────────────────────────────────────
  console.log("\nModels");
  const models = await api("GET", "/api/admin/warehouse/models");
  ok("model list returns", models.status === 200 && Array.isArray(models.json));
  ok("the 117 backfilled models are there", (models.json?.length ?? 0) >= 117, `${models.json?.length} models`);
  const big = (models.json ?? []).find((m: any) => m.variantCount >= 100);
  ok("a model reports its variant count", !!big, big ? `${big.title} — ${big.variantCount} variants` : "none found");
  ok("title and vendor model are SEPARATE fields (spec §1)",
    !!big && !!big.vendorModel && !String(big.title).includes(big.vendorModel),
    big ? `"${big.title}" + "${big.vendorModel}"` : "");

  const search = await api("GET", "/api/admin/warehouse/models?q=" + encodeURIComponent(big?.vendorModel ?? "shirt"));
  ok("search finds a model by its article number", (search.json?.length ?? 0) >= 1);

  // ── Expansion: the tap that opens a model ────────────────────────────────
  console.log("\nVariants under a model");
  const variants = await api("GET", `/api/admin/warehouse/models/${big.id}/variants`);
  ok("model expands to its variants", variants.status === 200 && (variants.json?.length ?? 0) === big.variantCount,
    `${variants.json?.length} of ${big.variantCount}`);
  const withColour = (variants.json ?? []).filter((v: any) => v.colour);
  ok("🔴 variants carry a REAL colour from the shop record, not a guessed name",
    withColour.length === variants.json.length, `${withColour.length}/${variants.json?.length}`);
  const withSize = (variants.json ?? []).filter((v: any) => v.sizeAsian);
  ok("variants carry a real size", withSize.length === variants.json.length, `${withSize.length}/${variants.json?.length}`);
  ok("every variant traces to this model", (variants.json ?? []).every((v: any) => v.modelId === big.id));

  // ── Batched details (what the counting screen calls) ──────────────────────
  console.log("\nBatched variant details");
  const ids = (variants.json ?? []).slice(0, 25).map((v: any) => v.id);
  const details = await api("POST", "/api/admin/warehouse/variant-details", { itemIds: ids });
  ok("batch returns one row per item", details.json?.details?.length === ids.length);
  ok("batch is capped", (await api("POST", "/api/admin/warehouse/variant-details",
    { itemIds: Array.from({ length: 501 }, (_, i) => i + 1) })).status === 400);

  // ── Autocomplete (spec §5) ───────────────────────────────────────────────
  console.log("\nAutocomplete");
  const sug = await api("GET", "/api/admin/warehouse/suggestions");
  ok("suggestions return", sug.status === 200);
  ok("🔴 colours are populated on day one (from the shop record, not wh_item_fields)",
    (sug.json?.colour?.length ?? 0) > 0, `${sug.json?.colour?.length} colours`);
  ok("sizes are populated", (sug.json?.sizeAsian?.length ?? 0) > 0, `${sug.json?.sizeAsian?.length} sizes`);

  // ── Registering mid-count, with a rack (D35 + spec §3) ───────────────────
  console.log("\nRegister an item mid-count");
  const barcode = `VERIFY${Date.now()}`;
  const reg = await api("POST", "/api/admin/warehouse/quick-item", {
    barcode, vendor: "VerifyCo", title: "Verification Shorts", vendorModel: "VER-1",
    colour: "Navy", sizeAsian: "L", rackCode: "l3", modelId: big.id,
  });
  ok("registers", reg.status === 201, reg.json?.message ?? "");
  if (reg.json?.item?.id) madeItemIds.push(reg.json.item.id);
  ok("🔴 rack code is uppercased (l3 → L3, so it is one rack not two)", reg.json?.item?.rackCode === "L3", reg.json?.item?.rackCode);
  ok("attaches to the model it was registered under", reg.json?.item?.modelId === big.id);
  ok("the response carries the rack back for the count line", reg.json?.line?.rackCode === "L3");

  const dup = await api("POST", "/api/admin/warehouse/quick-item", { barcode, title: "Duplicate attempt" });
  ok("🔴 a barcode already in use is refused", dup.status === 400, dup.json?.message);

  // ── Placement (D35) ──────────────────────────────────────────────────────
  console.log("\nPlacement");
  const place = await api("PATCH", `/api/admin/warehouse/items/${reg.json.item.id}/placement`, { rackCode: "c7" });
  ok("rack updates and normalises", place.json?.rackCode === "C7", place.json?.rackCode);
  const clearRack = await api("PATCH", `/api/admin/warehouse/items/${reg.json.item.id}/placement`, { rackCode: null });
  ok("rack can be cleared", clearRack.json?.rackCode === null);
  const badModel = await api("PATCH", `/api/admin/warehouse/items/${reg.json.item.id}/placement`, { modelId: "nonsense" });
  ok("a nonsense model id is refused, not coerced to null", badModel.status === 400);

  // ── CSV (spec §10) ───────────────────────────────────────────────────────
  console.log("\nCatalogue CSV");
  const csv = await api("GET", "/api/admin/warehouse/catalogue.csv");
  const header = csv.text.split("\n")[0].trim();
  const expected = "ID,Vendor,Title,Vendor Model,Our SKU,Item Notes,Colour,Asian size,EU size,Location,Barcode,Quantity,Variant Notes";
  ok("🔴 column order is EXACTLY the spec's", header === expected, header === expected ? "" : `got: ${header}`);
  ok("every catalogued item emits a row", csv.text.trim().split("\n").length >= 4727);
  ok("the registered barcode appears in the export", csv.text.includes(barcode));

  // ── Model CRUD + the un-grouping delete (D33) ────────────────────────────
  console.log("\nModel create / edit / delete");
  const made = await api("POST", "/api/admin/warehouse/models", { title: "Verification Model", vendor: "VerifyCo" });
  ok("creates a model", made.status === 201 && !!made.json?.id);
  if (made.json?.id) madeModelIds.push(made.json.id);
  const noTitle = await api("POST", "/api/admin/warehouse/models", { vendor: "VerifyCo" });
  ok("a model without a title is refused", noTitle.status === 400);

  const patched = await api("PATCH", `/api/admin/warehouse/models/${made.json.id}`, { vendor: "Renamed" });
  ok("patch updates only what was sent", patched.json?.vendor === "Renamed" && patched.json?.title === "Verification Model");

  // Move the registered item under the throwaway model, then delete it.
  await api("PATCH", `/api/admin/warehouse/items/${reg.json.item.id}/placement`, { modelId: made.json.id });
  const del = await api("DELETE", `/api/admin/warehouse/models/${made.json.id}`);
  ok("delete reports how many variants it released", del.json?.ungrouped === 1, `ungrouped ${del.json?.ungrouped}`);
  madeModelIds.pop();

  const survived = await pool.query("SELECT model_id FROM wh_items WHERE id = $1", [reg.json.item.id]);
  ok("🔴 deleting a model UN-GROUPS its variant — it does not delete it (D33)",
    survived.rows.length === 1 && survived.rows[0].model_id === null);

  // ── Nothing was counted by any of this ───────────────────────────────────
  const ledger = await pool.query("SELECT count(*)::int AS n FROM wh_movements");
  ok("🔴 no ledger movement was created by cataloguing", ledger.rows[0].n === 0, `${ledger.rows[0].n} movements`);

} catch (e) {
  fail++;
  console.error("\nverification threw:", e);
} finally {
  // ── Clean up ─────────────────────────────────────────────────────────────
  try {
    for (const id of madeItemIds) {
      await pool.query("DELETE FROM wh_barcode_aliases WHERE item_id = $1", [id]);
      await pool.query("DELETE FROM wh_item_fields WHERE item_id = $1", [id]);
      await pool.query("DELETE FROM wh_items WHERE id = $1", [id]);
    }
    for (const id of madeModelIds) await pool.query("DELETE FROM wh_models WHERE id = $1", [id]);
    if (userId) await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    console.log(`\ncleaned up ${madeItemIds.length} item(s), ${madeModelIds.length} model(s), 1 user`);
  } catch (e) {
    console.error("CLEANUP FAILED — remove by hand:", { madeItemIds, madeModelIds, userId }, e);
  }
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
