/**
 * Marketing Suite — the single boolean-tree segment evaluator (shared by segments
 * AND flow branch-splits, so there is only ever ONE engine).
 *
 * A definition is one boolean tree: `{ all: Node[] }` (AND) / `{ any: Node[] }`
 * (OR) with nested groups, leaves being one of four condition types:
 *   - profile_property  { type, path, op: eq|neq|contains|exists, value? }
 *   - consent           { type, channel, subState?, legalBasis? }
 *   - list_membership   { type, listId, op: in|not_in }
 *   - event             { type, metric, op: '>='|'='|'>'|'<='|'<'|'zero', count?, withinDays? }
 * It compiles to a single SQL predicate over mkt_profiles / mkt_list_members /
 * mkt_events (via mkt_metrics). The UI caps depth at 2 levels / ≤100 conditions;
 * the engine itself accepts deeper nesting (flow splits use it).
 *
 * `resolveAudience` turns a campaign's {include,exclude} of lists/segments into a
 * deduped profile-id list, then (optionally) through the suppression gate.
 * Segments > 500 members are materialised into mkt_segment_members with computed_at.
 *
 * Spec: synthesis tension X6 (one tree, one evaluator) + §(a).
 */

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { mktProfiles, mktListMembers, mktSegments, mktSegmentMembers } from "@shared/schema";
import { filterSendable, type FilterSendableResult, type MktChannel } from "./suppression";

const MAX_CONDITIONS = 200; // safety ceiling; the builder UI enforces ≤100.
const MATERIALISE_THRESHOLD = 500;

const KNOWN_COLS: Record<string, string> = {
  email: "email", first_name: "first_name", last_name: "last_name",
  phone_e164: "phone_e164", external_id: "external_id",
};

type Json = Record<string, any>;

/** Value expression for a profile property — a whitelisted column or a props jsonb path. */
function propValueExpr(path: string): SQL {
  const clean = String(path || "").trim();
  if (KNOWN_COLS[clean]) return sql.raw(`p.${KNOWN_COLS[clean]}`);
  const parts = clean.replace(/^props\./, "").split(".").map((s) => s.replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean);
  if (parts.length === 0) return sql`NULL`;
  const pgPath = `{${parts.join(",")}}`;
  return sql`(p.props #>> ${pgPath}::text[])`;
}

function compileProfileProperty(node: Json): SQL {
  const expr = propValueExpr(node.path);
  const op = String(node.op || "eq");
  const v = node.value;
  switch (op) {
    case "exists": return sql`${expr} IS NOT NULL`;
    case "contains": return sql`${expr} ILIKE ${"%" + String(v ?? "") + "%"}`;
    case "neq": return sql`${expr} IS DISTINCT FROM ${String(v ?? "")}`;
    case "eq":
    default: return sql`${expr} = ${String(v ?? "")}`;
  }
}

function compileConsent(node: Json): SQL {
  const conds: SQL[] = [sql`c.profile_id = p.id`, sql`c.channel = ${String(node.channel || "email")}`];
  if (node.subState) conds.push(sql`c.sub_state = ${String(node.subState)}`);
  if (node.legalBasis) conds.push(sql`c.legal_basis = ${String(node.legalBasis)}`);
  return sql`EXISTS (SELECT 1 FROM mkt_consent c WHERE ${sql.join(conds, sql` AND `)})`;
}

function compileListMembership(node: Json): SQL {
  const listId = Number(node.listId);
  if (!Number.isFinite(listId)) return sql`false`;
  const inner = sql`SELECT 1 FROM mkt_list_members m WHERE m.profile_id = p.id AND m.list_id = ${listId}`;
  return node.op === "not_in" ? sql`NOT EXISTS (${inner})` : sql`EXISTS (${inner})`;
}

function compileEvent(node: Json, workspaceId: number): SQL {
  const metric = String(node.metric || "");
  if (!metric) return sql`false`;
  const conds: SQL[] = [
    sql`e.profile_id = p.id`,
    sql`mt.workspace_id = ${workspaceId}`,
    sql`mt.name = ${metric}`,
  ];
  const within = Number(node.withinDays);
  if (Number.isFinite(within) && within > 0) {
    conds.push(sql`e.occurred_at >= now() - (${within} * interval '1 day')`);
  }
  const countSub = sql`(SELECT count(*) FROM mkt_events e JOIN mkt_metrics mt ON mt.id = e.metric_id WHERE ${sql.join(conds, sql` AND `)})`;
  const op = String(node.op || ">=");
  const count = Number(node.count ?? (op === "zero" ? 0 : 1));
  switch (op) {
    case "zero": return sql`${countSub} = 0`;
    case "=": return sql`${countSub} = ${count}`;
    case ">": return sql`${countSub} > ${count}`;
    case "<": return sql`${countSub} < ${count}`;
    case "<=": return sql`${countSub} <= ${count}`;
    case ">=":
    default: return sql`${countSub} >= ${count}`;
  }
}

interface CompileCtx { workspaceId: number; count: { n: number } }

function compileNode(node: Json, ctx: CompileCtx): SQL {
  if (!node || typeof node !== "object") return sql`true`;

  if (Array.isArray(node.all)) {
    const parts = node.all.map((n: Json) => compileNode(n, ctx));
    return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : sql`true`;
  }
  if (Array.isArray(node.any)) {
    const parts = node.any.map((n: Json) => compileNode(n, ctx));
    return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`false`;
  }

  ctx.count.n++;
  if (ctx.count.n > MAX_CONDITIONS) throw new Error(`Segment definition exceeds ${MAX_CONDITIONS} conditions`);

  switch (String(node.type)) {
    case "profile_property": return compileProfileProperty(node);
    case "consent": return compileConsent(node);
    case "list_membership": return compileListMembership(node);
    case "event": return compileEvent(node, ctx.workspaceId);
    default: return sql`true`;
  }
}

/** Compile a definition to the WHERE predicate (workspace-scoped). */
function compileDefinition(definition: Json, workspaceId: number): SQL {
  const ctx: CompileCtx = { workspaceId, count: { n: 0 } };
  const tree = compileNode(definition || {}, ctx);
  return sql`(p.workspace_id = ${workspaceId} AND ${tree})`;
}

/** Evaluate a segment definition live → matching profile ids. */
export async function evaluateDefinition(definition: Json, workspaceId: number): Promise<number[]> {
  const where = compileDefinition(definition, workspaceId);
  const res = await db.execute(sql`SELECT p.id FROM mkt_profiles p WHERE ${where}`);
  return (res.rows as { id: number }[]).map((r) => Number(r.id));
}

/** Count a definition live (for the builder's live-count preview). */
export async function previewCount(definition: Json, workspaceId: number): Promise<number> {
  const where = compileDefinition(definition, workspaceId);
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM mkt_profiles p WHERE ${where}`);
  return Number((res.rows[0] as { n: number })?.n ?? 0);
}

/**
 * Compute a stored segment: refresh member_count + last_computed_at; materialise
 * mkt_segment_members only when the segment is large (> 500), otherwise clear the
 * cache and rely on live evaluation.
 */
export async function computeSegment(segmentId: number, workspaceId: number): Promise<{ count: number; materialised: boolean }> {
  const [seg] = await db.select().from(mktSegments)
    .where(and(eq(mktSegments.id, segmentId), eq(mktSegments.workspaceId, workspaceId))).limit(1);
  if (!seg) return { count: 0, materialised: false };

  const ids = await evaluateDefinition(seg.definition as Json, workspaceId);
  const now = new Date();
  const materialise = ids.length > MATERIALISE_THRESHOLD;

  await db.delete(mktSegmentMembers).where(eq(mktSegmentMembers.segmentId, segmentId));
  if (materialise) {
    // Insert in chunks to keep parameter counts sane.
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      await db.insert(mktSegmentMembers)
        .values(chunk.map((profileId) => ({ segmentId, profileId, computedAt: now })))
        .onConflictDoNothing();
    }
  }
  await db.update(mktSegments)
    .set({ memberCount: ids.length, lastComputedAt: now, updatedAt: now })
    .where(eq(mktSegments.id, segmentId));
  return { count: ids.length, materialised: materialise };
}

// ── Audience resolution ────────────────────────────────────────────────────
export interface AudienceRef { type: "list" | "segment" | "all"; id?: number }
export interface CampaignAudience { include?: AudienceRef[]; exclude?: AudienceRef[] }

async function allProfileIds(workspaceId: number): Promise<number[]> {
  const rows = await db.select({ id: mktProfiles.id }).from(mktProfiles).where(eq(mktProfiles.workspaceId, workspaceId));
  return rows.map((r) => r.id);
}

async function listMemberIds(listId: number, workspaceId: number): Promise<number[]> {
  const rows = await db.select({ id: mktListMembers.profileId })
    .from(mktListMembers)
    .innerJoin(mktProfiles, eq(mktProfiles.id, mktListMembers.profileId))
    .where(and(eq(mktListMembers.listId, listId), eq(mktProfiles.workspaceId, workspaceId)));
  return rows.map((r) => r.id);
}

async function segmentIds(segmentId: number, workspaceId: number): Promise<number[]> {
  const [seg] = await db.select().from(mktSegments)
    .where(and(eq(mktSegments.id, segmentId), eq(mktSegments.workspaceId, workspaceId))).limit(1);
  if (!seg) return [];
  return evaluateDefinition(seg.definition as Json, workspaceId);
}

async function refIds(ref: AudienceRef, workspaceId: number): Promise<number[]> {
  if (ref.type === "all") return allProfileIds(workspaceId);
  if (ref.id == null) return [];
  if (ref.type === "list") return listMemberIds(ref.id, workspaceId);
  if (ref.type === "segment") return segmentIds(ref.id, workspaceId);
  return [];
}

export interface ResolveAudienceResult {
  profileIds: number[];
  total: number;
  gate?: FilterSendableResult;
}

/**
 * Resolve include(lists/segments) minus exclude → deduped profile ids. When a
 * `gate` is supplied, run the result through the suppression gate and return only
 * sendable ids (plus the full gate breakdown for the audience-estimate endpoint).
 */
export async function resolveAudience(
  audience: CampaignAudience,
  workspaceId: number,
  gate?: { channel: MktChannel; isMarketing: boolean; category?: string | null; listId?: number | null },
): Promise<ResolveAudienceResult> {
  const includeRefs = audience?.include ?? [];
  const excludeRefs = audience?.exclude ?? [];

  const include = new Set<number>();
  for (const ref of includeRefs) for (const id of await refIds(ref, workspaceId)) include.add(id);
  const exclude = new Set<number>();
  for (const ref of excludeRefs) for (const id of await refIds(ref, workspaceId)) exclude.add(id);

  const resolved = Array.from(include).filter((id) => !exclude.has(id));
  const total = resolved.length;

  if (!gate) return { profileIds: resolved, total };

  const result = await filterSendable(resolved, {
    workspaceId, channel: gate.channel, isMarketing: gate.isMarketing,
    category: gate.category ?? null, listId: gate.listId ?? null,
  });
  return { profileIds: result.sendable.map((p) => p.id), total, gate: result };
}
