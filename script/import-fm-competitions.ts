// Import Friendly Manager COMPETITIONS history (2021-2025) into ClubOS.
// Source: data/friendly-manager-export/2026-07-17/parsed/*.csv
// Targets: fm_competition_history / _teams / _games / _placings (apply-fm-competitions.ts).
// Org segmentation: cic → 5 · social-league → 3 (MFL) · festival → 1 (CUFC).
//
// DRY RUN default (single transaction, ROLLBACK); --commit persists. Idempotent
// on natural keys (ON CONFLICT DO NOTHING). Verification report reconciles row
// counts against the export's own reconciliation.json — mismatch means STOP.
//
// Usage: npx tsx script/import-fm-competitions.ts [--dir <parsed-dir>] [--commit]
import "dotenv/config";
import pg from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const ORG_BY_SEGMENT: Record<string, number> = { cic: 5, "social-league": 3, festival: 1 };
const BATCH = 500;
const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = "", q = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (ch !== "\r") f += ch;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}
function csvObjects(file: string): Record<string, string>[] {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const hdr = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(hdr.map((h, i) => [h, (r[i] ?? "").trim()])));
}
const nz = (s?: string) => { const t = (s ?? "").trim(); return t === "" ? null : t; };
const num = (s?: string) => { const t = (s ?? "").trim(); return t === "" || isNaN(Number(t)) ? null : parseInt(t, 10); };
const dateOk = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null);
function chunks<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function valuesSql(rows: number, cols: number): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) { const cs: string[] = []; for (let c = 0; c < cols; c++) cs.push(`$${r * cols + c + 1}`); out.push(`(${cs.join(",")})`); }
  return out.join(",");
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : path.resolve(__dirname, "../../../data/friendly-manager-export/2026-07-17/parsed");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");

  const comps = csvObjects(path.join(dir, "competitions.csv"));
  const teams = csvObjects(path.join(dir, "teams.csv"));
  const games = csvObjects(path.join(dir, "games.csv"));
  const placings = csvObjects(path.join(dir, "placings.csv"));
  const recon = JSON.parse(fs.readFileSync(path.join(dir, "reconciliation.json"), "utf8"));
  console.log(`Loaded: ${comps.length} comps, ${teams.length} teams, ${games.length} games, ${placings.length} placings`);
  console.log(`Reconciliation expects: comps ${recon.competitions}, teams ${recon.teams}, games ${recon.games_total ?? recon.games}, placings ${recon.placings}`);
  if (comps.length !== recon.competitions || teams.length !== recon.teams || placings.length !== recon.placings) {
    throw new Error("CSV row counts do not match reconciliation.json — STOPPING.");
  }

  const orgOf = new Map<string, number>();
  for (const c of comps) {
    const org = ORG_BY_SEGMENT[c.segment];
    if (!org) throw new Error(`Unknown segment '${c.segment}' for comp ${c.id} — refusing to guess an org.`);
    orgOf.set(c.id, org);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const stats: any = { comps: 0, compConflict: 0, teams: 0, teamConflict: 0, games: 0, gameConflict: 0, scored: 0, placings: 0, placingConflict: 0, byOrg: {} as Record<string, number> };
  try {
    await client.query("BEGIN");

    for (const batch of chunks(comps, BATCH)) {
      const params: any[] = [];
      for (const c of batch) {
        params.push(orgOf.get(c.id), num(c.id), c.name, dateOk(c.start), dateOk(c.end), num(c.season_year), c.segment, "friendly_manager");
        stats.byOrg[orgOf.get(c.id)!] = (stats.byOrg[orgOf.get(c.id)!] || 0) + 1;
      }
      const r = await client.query(
        `INSERT INTO fm_competition_history (organization_id, fm_comp_id, name, start_date, end_date, season_year, segment, source)
         VALUES ${valuesSql(batch.length, 8)} ON CONFLICT (fm_comp_id) DO NOTHING RETURNING id`, params);
      stats.comps += r.rows.length; stats.compConflict += batch.length - r.rows.length;
    }

    for (const batch of chunks(teams, BATCH)) {
      const params: any[] = [];
      for (const t of batch) params.push(orgOf.get(t.comp_id), num(t.comp_id), num(t.division_id), nz(t.division_name), t.team_name, nz(t.club_name), nz(t.manager_name), nz(t.manager_phone), nz(t.manager_email), num(t.num_players), "friendly_manager");
      const r = await client.query(
        `INSERT INTO fm_competition_teams (organization_id, fm_comp_id, fm_division_id, division_name, team_name, club_name, manager_name, manager_phone, manager_email, num_players, source)
         VALUES ${valuesSql(batch.length, 11)} ON CONFLICT (fm_comp_id, (coalesce(fm_division_id, -1)), team_name) DO NOTHING RETURNING id`, params);
      stats.teams += r.rows.length; stats.teamConflict += batch.length - r.rows.length;
    }

    const occ = new Map<string, number>();
    for (const batch of chunks(games, BATCH)) {
      const params: any[] = [];
      for (const g of batch) {
        const hs = num(g.home_score), as = num(g.away_score);
        const base = [g.round_id, g.game_date, g.home_team, g.away_team].join("|");
        const n = (occ.get(base) || 0) + 1; occ.set(base, n);
        const key = sha1(`${base}|${n}`);
        if (g.status === "scored" || (hs !== null && as !== null)) stats.scored++;
        params.push(orgOf.get(g.comp_id) ?? 1, num(g.comp_id), num(g.division_id), num(g.round_id), nz(g.pool), dateOk(g.game_date), nz(g.game_time), nz(g.venue), g.home_team, g.away_team, hs, as, g.status || "unscored", key, "friendly_manager");
      }
      const r = await client.query(
        `INSERT INTO fm_competition_games (organization_id, fm_comp_id, fm_division_id, fm_round_id, pool, game_date, game_time, venue, home_team, away_team, home_score, away_score, status, external_key, source)
         VALUES ${valuesSql(batch.length, 15)} ON CONFLICT (external_key) DO NOTHING RETURNING id`, params);
      stats.games += r.rows.length; stats.gameConflict += batch.length - r.rows.length;
    }

    for (const batch of chunks(placings, BATCH)) {
      const params: any[] = [];
      // placing values are ordinals ("1st", "2nd") — digits only
      for (const p of batch) {
        const place = num((p.placing || "").replace(/\D/g, ""));
        if (place === null) throw new Error(`Unparseable placing '${p.placing}' (comp ${p.comp_id}) — refusing to guess.`);
        params.push(orgOf.get(p.comp_id) ?? 1, num(p.comp_id), num(p.division_id), place, p.team_name, nz(p.club_name), "friendly_manager");
      }
      const r = await client.query(
        `INSERT INTO fm_competition_placings (organization_id, fm_comp_id, fm_division_id, place, team_name, club_name, source)
         VALUES ${valuesSql(batch.length, 7)} ON CONFLICT (fm_comp_id, (coalesce(fm_division_id, -1)), place, team_name) DO NOTHING RETURNING id`, params);
      stats.placings += r.rows.length; stats.placingConflict += batch.length - r.rows.length;
    }

    console.log("\n================ IMPORT REPORT ================");
    console.log(JSON.stringify(stats, null, 2));
    console.log(`orgs: cic→5 (${stats.byOrg[5] ?? 0} comps) · social→3 (${stats.byOrg[3] ?? 0}) · festival→1 (${stats.byOrg[1] ?? 0})`);
    const sample = await client.query(`
      SELECT h.name, h.segment, count(DISTINCT t.id) teams, count(DISTINCT g.id) games
      FROM fm_competition_history h
      LEFT JOIN fm_competition_teams t ON t.fm_comp_id = h.fm_comp_id
      LEFT JOIN fm_competition_games g ON g.fm_comp_id = h.fm_comp_id
      GROUP BY h.id ORDER BY random() LIMIT 8`);
    console.log("\nSample comps:"); for (const s of sample.rows) console.log(` ${s.name} [${s.segment}] teams:${s.teams} games:${s.games}`);

    if (commit) { await client.query("COMMIT"); console.log("\nCOMMITTED."); }
    else { await client.query("ROLLBACK"); console.log("\nDRY RUN — rolled back. Re-run with --commit."); }
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
