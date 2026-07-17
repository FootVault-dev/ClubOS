// SportNinja history importer → ClubOS (source='sportninja').
// Reads the local harvest (data/sportninja-export/2026-07-17/raw) and loads:
//   sn_seasons, sn_teams, sn_roster, sn_games, sn_standings, sn_payments, sn_registrations
// Emailable players are matched to existing contacts (by lower(email)) or created.
// Single transaction, idempotent (ON CONFLICT DO NOTHING on unique keys), dry-run default.
// Never touches the live league_* system.
//
// Usage:  npx tsx script/import-sn-history.ts --dry-run   (rehearse, rolled back)
//         npx tsx script/import-sn-history.ts             (apply)
import "dotenv/config";
import pg from "pg";
import fs from "fs";
import path from "path";

const EXPORT_DIR = process.env.SN_EXPORT_DIR ||
  "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/data/sportninja-export/2026-07-17";
const RAW = path.join(EXPORT_DIR, "raw");
const BATCH = 500;
const TAGS = "sportninja-import,mfl";

// ---------- helpers ----------
const lc = (s: any) => (s == null ? "" : String(s)).trim().toLowerCase();
const nz = (s: any) => { const v = (s == null ? "" : String(s)).trim(); return v === "" ? null : v; };
function readJson(p: string): any { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function dataOf(o: any): any[] {
  if (!o) return [];
  if (Array.isArray(o)) return o;
  const d = o.data ?? o;
  return Array.isArray(d) ? d : [d];
}
function listDirs(p: string): string[] {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(p, d.name)); }
  catch { return []; }
}
function listFiles(p: string): string[] {
  try { return fs.readdirSync(p).filter(f => f.endsWith(".json")).map(f => path.join(p, f)); }
  catch { return []; }
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function csvObjects(file: string): Record<string, string>[] {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return [];
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length < 2) return [];
  const head = rows[0];
  return rows.slice(1).filter(r => r.length && r.some(c => c !== "")).map(r => {
    const o: Record<string, string> = {};
    head.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}
function walkCsv(glob: string): Record<string, string>[] {
  // glob = subpath pattern like "reports/registration_transaction.csv" under schedules/* and orgs/*
  const out: Record<string, string>[] = [];
  for (const base of ["schedules", "orgs"]) {
    for (const d of listDirs(path.join(RAW, base))) {
      const f = path.join(d, glob);
      if (fs.existsSync(f)) out.push(...csvObjects(f));
    }
  }
  return out;
}
function toDate(s: any): string | null {
  const v = nz(s); if (!v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function toTs(s: any): string | null { const v = nz(s); return v && /\d{4}-\d{2}-\d{2}/.test(v) ? v : null; }
function cents(s: any): number | null {
  const v = String(s ?? "").replace(/[$,]/g, "").trim(); if (v === "") return null;
  const n = Number(v); return isNaN(n) ? null : Math.round(n * 100);
}
function chunks<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function valuesSql(rows: number, cols: number): string {
  const parts: string[] = []; let k = 1;
  for (let r = 0; r < rows; r++) parts.push("(" + Array.from({ length: cols }, () => "$" + k++).join(",") + ")");
  return parts.join(",");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  if (!fs.existsSync(RAW)) throw new Error("raw export not found at " + RAW);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const st: Record<string, number> = {};
  const inc = (k: string, n = 1) => (st[k] = (st[k] || 0) + n);

  try {
    await client.query("BEGIN");

    // ---------- 1. SEASONS ----------
    const seasons: any[][] = [];
    for (const d of listDirs(path.join(RAW, "schedules"))) {
      const s = (readJson(path.join(d, "schedule.json")) || {}).data;
      if (!s?.id) continue;
      const org = s.organization || {};
      seasons.push([s.id, org.id ?? null, org.name_full ?? org.name ?? null,
        s.name_full ?? s.name ?? "(unnamed)", toDate(s.starts_at), toDate(s.ends_at),
        !!s.is_archive, !!s.is_tournament, s.games_count ?? null, s.teams_count ?? null,
        JSON.stringify(s)]);
    }
    for (const b of chunks(seasons, BATCH)) {
      const res = await client.query(
        `INSERT INTO sn_seasons (sn_schedule_id, sn_org_id, organization_name, name, starts_on,
           ends_on, is_archive, is_tournament, games_count, teams_count, raw_json)
         VALUES ${valuesSql(b.length, 11)} ON CONFLICT (sn_schedule_id) DO NOTHING RETURNING id`,
        b.flat());
      inc("seasons", res.rows.length);
    }

    // ---------- 2. TEAMS ----------
    const teams: any[][] = []; const seenTeam = new Set<string>();
    for (const d of listDirs(path.join(RAW, "teams"))) {
      const t = (readJson(path.join(d, "team.json")) || {}).data;
      if (!t?.id || seenTeam.has(t.id)) continue; seenTeam.add(t.id);
      const org = t.organization || {};
      teams.push([t.id, t.name_full ?? t.name ?? "(unnamed)", org.id ?? null,
        org.name_full ?? org.name ?? null, JSON.stringify(t)]);
    }
    for (const b of chunks(teams, BATCH)) {
      const res = await client.query(
        `INSERT INTO sn_teams (sn_team_id, name, sn_org_id, organization_name, raw_json)
         VALUES ${valuesSql(b.length, 5)} ON CONFLICT (sn_team_id) DO NOTHING RETURNING id`, b.flat());
      inc("teams", res.rows.length);
    }

    // ---------- 3. ROSTER + CONTACTS ----------
    // gather roster rows from every org rollup CSV; dedup by external_key later via ON CONFLICT
    const rosterRows: Record<string, string>[] = [];
    for (const d of listDirs(path.join(RAW, "orgs"))) {
      const f = path.join(d, "reports", "rollup_team-players.csv");
      if (fs.existsSync(f)) rosterRows.push(...csvObjects(f));
    }
    // unique emails -> match/create contacts
    const emailToContact = new Map<string, number>();
    const emails = [...new Set(rosterRows.map(r => lc(r["Email"])).filter(e => e && e.includes("@")))];
    for (const b of chunks(emails, BATCH)) {
      const res = await client.query(
        `SELECT id, lower(email) e FROM contacts WHERE lower(email) = ANY($1)`, [b]);
      for (const r of res.rows) emailToContact.set(r.e, r.id);
    }
    inc("contactsMatched", emailToContact.size);
    // create contacts for emails not found (use best name/dob seen for that email)
    const bestByEmail = new Map<string, Record<string, string>>();
    for (const r of rosterRows) {
      const e = lc(r["Email"]); if (!e || !e.includes("@")) continue;
      if (!bestByEmail.has(e) || (!bestByEmail.get(e)!["First Name"] && r["First Name"])) bestByEmail.set(e, r);
    }
    const toCreate = [...bestByEmail.entries()].filter(([e]) => !emailToContact.has(e));
    for (const b of chunks(toCreate, BATCH)) {
      const params: any[] = [];
      for (const [e, r] of b) {
        params.push("player", nz(r["First Name"]) || "(unknown)", nz(r["Last Name"]) || "(unknown)",
          e, toDate(r["Birth Date"]), TAGS,
          "Imported from SportNinja 2026-07-17 (MFL social-league player)");
      }
      const res = await client.query(
        `INSERT INTO contacts (type, first_name, last_name, email, date_of_birth, tags, notes)
         VALUES ${valuesSql(b.length, 7)} RETURNING id, lower(email) e`, params);
      for (const row of res.rows) emailToContact.set(row.e, row.id);
      inc("contactsCreated", res.rows.length);
    }
    // insert roster rows
    const rosterIns: any[][] = [];
    for (const r of rosterRows) {
      const pid = r["SN Player ID"], tid = r["SN Team ID"], cid = r["Competition ID"];
      if (!pid && !tid) continue;
      const key = `${pid || "?"}|${tid || "?"}|${cid || "?"}`;
      const e = lc(r["Email"]);
      rosterIns.push([emailToContact.get(e) ?? null, nz(pid), nz(r["First Name"]), nz(r["Last Name"]),
        nz(r["Email"]), toDate(r["Birth Date"]), nz(r["Jersey Number"]), nz(r["Position"]),
        nz(tid), nz(r["Team Name"]), nz(cid), nz(r["Competition"]), nz(r["Organization"]), key]);
    }
    for (const b of chunks(rosterIns, BATCH)) {
      const res = await client.query(
        `INSERT INTO sn_roster (contact_id, sn_player_id, first_name, last_name, email, birth_date,
           jersey_number, position, sn_team_id, team_name, sn_schedule_id, competition_name,
           organization_name, external_key)
         VALUES ${valuesSql(b.length, 14)} ON CONFLICT (external_key) DO NOTHING RETURNING id`, b.flat());
      inc("roster", res.rows.length);
    }

    // ---------- 4. GAMES ----------
    const gameIns: any[][] = [];
    for (const d of listDirs(path.join(RAW, "schedules"))) {
      const gdDir = path.join(d, "games_detail");
      const sched = (readJson(path.join(d, "schedule.json")) || {}).data || {};
      for (const gf of listFiles(gdDir)) {
        const g = (readJson(gf) || {}).data; if (!g?.id) continue;
        const home = g.homeTeam || {}, vis = g.visitingTeam || {};
        const goals = Array.isArray(g.goals) ? g.goals : [];
        let hs: number | null = null, vs: number | null = null;
        if (goals.length) {
          hs = 0; vs = 0;
          for (const gl of goals) {
            const tid = gl?.shot?.team_id;
            if (tid && tid === home.id) hs!++;
            else if (tid && tid === vis.id) vs!++;
          }
        }
        const venue = (g.venue && (g.venue.name || g.venue.name_full)) || (g.facility && g.facility.name) || null;
        gameIns.push([g.id, sched.id ?? (g.schedule && g.schedule.id) ?? null,
          sched.name_full ?? sched.name ?? null, (sched.organization && (sched.organization.name_full || sched.organization.name)) ?? null,
          nz(home.name_full || home.name), nz(vis.name_full || vis.name), home.id ?? null, vis.id ?? null,
          hs, vs, toTs(g.starts_at), g.game_status_id != null ? String(g.game_status_id) : null,
          venue, goals.length]);
      }
    }
    for (const b of chunks(gameIns, BATCH)) {
      const res = await client.query(
        `INSERT INTO sn_games (sn_game_id, sn_schedule_id, competition_name, organization_name,
           home_team, visitor_team, sn_home_team_id, sn_visitor_team_id, home_score, visitor_score,
           starts_at, status, venue, goals_count)
         VALUES ${valuesSql(b.length, 14)} ON CONFLICT (sn_game_id) DO NOTHING RETURNING id`, b.flat());
      inc("games", res.rows.length);
    }

    // ---------- 5. STANDINGS ----------
    const standIns: any[][] = [];
    for (const d of listDirs(path.join(RAW, "schedules"))) {
      const rows = dataOf(readJson(path.join(d, "standings.json")));
      rows.forEach((row: any, idx: number) => {
        const team = row.team || {}, sc = row.schedule || {};
        const stat: Record<string, any> = {};
        for (const s of (row.stats || [])) stat[s.abbr] = s.value;
        const key = `${sc.id || "?"}|${team.id || "?"}`;
        if (!team.id && !sc.id) return;
        standIns.push([sc.id ?? null, sc.name ?? null, team.id ?? null, team.name_full ?? team.name ?? null,
          idx + 1, stat["MP"] ?? null, stat["W"] ?? null, stat["D"] ?? null, stat["L"] ?? null,
          stat["GF"] ?? null, stat["GA"] ?? null, stat["GD"] ?? null, stat["PTS"] ?? null,
          JSON.stringify(row), key]);
      });
    }
    for (const b of chunks(standIns, BATCH)) {
      const res = await client.query(
        `INSERT INTO sn_standings (sn_schedule_id, competition_name, sn_team_id, team_name, rank,
           games_played, wins, draws, losses, goals_for, goals_against, goal_difference, points,
           raw_json, external_key)
         VALUES ${valuesSql(b.length, 15)} ON CONFLICT (external_key) DO NOTHING RETURNING id`, b.flat());
      inc("standings", res.rows.length);
    }

    // ---------- 6. PAYMENTS ----------
    const payRaw = walkCsv(path.join("reports", "registration_transaction.csv"));
    const paySeen = new Set<string>(); const payIns: any[][] = [];
    for (const r of payRaw) {
      const txid = nz(r["Provider Transaction ID"]);
      const key = txid || [r["Competition ID"], r["Team ID"], r["Player"], r["Player Email"],
        r["Transaction Date"], r["Total"], r["Payment Status"]].join("|");
      if (paySeen.has(key)) continue; paySeen.add(key);
      const e = lc(r["Player Email"]);
      payIns.push([emailToContact.get(e) ?? null, nz(r["Competition"]), nz(r["Team"]), nz(r["Player"]),
        nz(r["Player Email"]), nz(r["Payment Type"]), toDate(r["Transaction Date"]),
        cents(r["Total"]), cents(r["Tax Total"]), nz(r["Currency Code"]) || "NZD",
        nz(r["Payment Status"]), nz(r["Payment Provider"]), txid, key]);
    }
    for (const b of chunks(payIns, BATCH)) {
      const res = await client.query(
        `INSERT INTO sn_payments (contact_id, competition_name, team_name, player_name, player_email,
           payment_type, paid_on, amount_cents, tax_cents, currency, payment_status, provider,
           provider_txn_id, external_key)
         VALUES ${valuesSql(b.length, 14)} ON CONFLICT (external_key) DO NOTHING RETURNING id`, b.flat());
      inc("payments", res.rows.length);
    }

    // ---------- 7. REGISTRATIONS ----------
    const regIns: any[][] = []; const regSeen = new Set<string>();
    for (const [glob, kind] of [["registration_team_registrations.csv", "team"],
                                 ["registration_player_registrations.csv", "player"]] as const) {
      for (const r of walkCsv(path.join("reports", glob))) {
        const key = [kind, r["Competition"] || "", r["Team ID"] || "",
          r["Player"] || r["Team Official"] || r["Team"] || "",
          r["Registration Type"] || ""].join("|");
        if (regSeen.has(key)) continue; regSeen.add(key);
        const email = nz(r["Player Email"] || r["Team Official Email"] || r["Email"]);
        const name = nz(r["Player"] || r["Team Official"] || r["Team"]);
        regIns.push([kind, nz(r["Competition"]), nz(r["Team"]), name, email,
          nz(r["Registration Status"]), emailToContact.get(lc(email)) ?? null, JSON.stringify(r), key]);
      }
    }
    for (const b of chunks(regIns, BATCH)) {
      const res = await client.query(
        `INSERT INTO sn_registrations (kind, competition_name, team_name, registrant_name,
           registrant_email, registration_status, contact_id, raw_json, external_key)
         VALUES ${valuesSql(b.length, 9)} ON CONFLICT (external_key) DO NOTHING RETURNING id`, b.flat());
      inc("registrations", res.rows.length);
    }

    // ---------- report ----------
    console.log("\n=== SPORTNINJA IMPORT (" + (dryRun ? "DRY RUN" : "APPLY") + ") ===");
    for (const k of ["seasons", "teams", "contactsMatched", "contactsCreated", "roster",
                     "games", "standings", "payments", "registrations"]) {
      console.log(`  ${k.padEnd(16)} ${st[k] || 0}`);
    }
    const payTotal = payIns.reduce((a, r) => a + (r[7] || 0), 0);
    console.log(`  payments total   $${(payTotal / 100).toLocaleString()} NZD (rows parsed: ${payIns.length})`);

    if (dryRun) { await client.query("ROLLBACK"); console.log("\nDRY RUN — rolled back. Nothing changed."); }
    else { await client.query("COMMIT"); console.log("\nCOMMITTED."); }
  } catch (e) {
    await client.query("ROLLBACK"); throw e;
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
