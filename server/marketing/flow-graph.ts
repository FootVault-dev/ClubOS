/**
 * Marketing Suite — the PURE flow-graph core (Phase E).
 *
 * This module is deliberately DB-free and Express-free: it holds only the flow
 * graph model, the graph-walk / step-resolution helpers, delay parsing,
 * quiet-hours scheduling, and merge-tag rendering. Everything with a side effect
 * (send, enrol, DB writes, job scheduling) lives in ./flows.ts.
 *
 * Keeping this split means the runtime's decision logic is unit-testable with no
 * database (script/test-flows-graph.ts imports THIS file only). Its single import
 * is the SMS lib's quiet-hours helpers (also DB-free), so the test stays offline.
 *
 * Spec: plan Phase E + 03-flows-automation-roi.md §A (the trigger + step model) +
 * synthesis §5/§6 (re-evaluating versioned state machine, job_key debounce).
 */

import { isQuietHours, nextSendableTime } from "./sms";

// ── Graph model (stored in mkt_flow_versions.graph jsonb) ────────────────────
// A linear-with-branches graph: an ordered list of steps, each pointing at the
// next step id (and, for a condition, a false branch). Rendered as a vertical
// step list in the editor, never a free-form canvas.

export type FlowStepType = "delay" | "condition" | "email" | "sms" | "update_property" | "exit";

export interface FlowStep {
  id: string;
  type: FlowStepType;
  config: Record<string, any>;
  /** Default edge — the next step id, or null to end the flow. */
  next: string | null;
  /** Condition-only false branch; falls back to `next` when omitted. */
  nextIfFalse?: string | null;
}

export interface FlowGraph {
  steps: FlowStep[];
  /** Entry step id; defaults to the first step when unset. */
  entry?: string | null;
}

// Per-type config shapes (documented; validated loosely at runtime).
export interface DelayConfig { value: number; unit: "minutes" | "hours" | "days" }
export interface ConditionConfig { definition: Record<string, any> }
export interface EmailStepConfig { subject: string; bodyHtml: string; templateId?: number; isMarketing?: boolean }
export interface SmsStepConfig { body: string; isMarketing?: boolean }
export interface UpdatePropertyConfig { path: string; value: unknown }
export interface ExitConfig { reason?: string }

// ── Graph-walk helpers (pure) ────────────────────────────────────────────────

export function normalizeGraph(raw: unknown): FlowGraph {
  const g = (raw && typeof raw === "object" ? raw : {}) as Partial<FlowGraph>;
  const steps = Array.isArray(g.steps) ? g.steps.filter((s): s is FlowStep => !!s && typeof s === "object" && typeof (s as any).id === "string") : [];
  return { steps, entry: g.entry ?? (steps[0]?.id ?? null) };
}

export function entryStepId(graph: FlowGraph): string | null {
  if (graph.entry) return graph.entry;
  return graph.steps[0]?.id ?? null;
}

export function getStep(graph: FlowGraph, id: string | null | undefined): FlowStep | undefined {
  if (!id) return undefined;
  return graph.steps.find((s) => s.id === id);
}

export function isMessageStep(step: FlowStep | undefined): boolean {
  return step?.type === "email" || step?.type === "sms";
}

/**
 * Resolve the next step id from a step. For a condition, `branchPass` picks the
 * edge (true → next, false → nextIfFalse ?? next). For every other step type the
 * boolean is ignored and `next` is returned. Returns null to end the flow.
 */
export function resolveNext(step: FlowStep, branchPass?: boolean): string | null {
  if (step.type === "condition" && branchPass === false) {
    // Distinguish an explicit `null` false-edge (exit the flow) from an absent one
    // (fall through to `next`). The visual editor writes nextIfFalse:null to mean
    // "if the condition isn't met, exit" — a gate.
    if (Object.prototype.hasOwnProperty.call(step, "nextIfFalse")) return step.nextIfFalse ?? null;
    return step.next ?? null;
  }
  return step.next ?? null;
}

// ── Delay parsing (pure) ─────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** Convert a delay step config to milliseconds. Unknown units → hours; clamped ≥0. */
export function delayToMs(config: Partial<DelayConfig> | undefined | null): number {
  const value = Number(config?.value);
  if (!Number.isFinite(value) || value < 0) return 0;
  const unit = String(config?.unit || "hours");
  const per = UNIT_MS[unit] ?? UNIT_MS.hours;
  return Math.round(value * per);
}

// ── Quiet-hours scheduling (pure, DST-safe via the SMS lib) ───────────────────

/**
 * Given a candidate run time and whether the step about to run is a message
 * step, return the time it should actually run at: unchanged for non-message
 * steps, and bumped to the next sendable NZ time (08:00 Pacific/Auckland) when a
 * message would otherwise land in the 20:00–08:00 quiet window (D7). Pure — the
 * quiet-hours math is Intl-only in the SMS lib.
 */
export function scheduleForStep(runAt: Date, isMessage: boolean): Date {
  if (!isMessage) return runAt;
  return isQuietHours(runAt) ? nextSendableTime(runAt) : runAt;
}

// ── Merge tags (pure) ────────────────────────────────────────────────────────

export interface MergeCtx {
  first_name: string;
  last_name: string;
  email: string;
  unsubscribe_url: string;
  preferences_url: string;
}

/** Replace {{first_name}} etc. — same tag set + behaviour as the campaign engine. */
export function renderMergeTags(input: string | null | undefined, ctx: MergeCtx): string {
  if (!input) return "";
  const map: Record<string, string> = { ...ctx } as any;
  return input.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, key: string) => {
    const v = map[String(key).toLowerCase()];
    return v == null ? "" : String(v);
  });
}

/** Guarantee a visible unsubscribe + preferences footer on a flow email. */
export function ensureFooter(html: string, ctx: MergeCtx, brandName: string): string {
  if (html.includes(ctx.unsubscribe_url)) return html;
  const footer = `
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#8a8a8a;text-align:center;">
    <p style="margin:0 0 6px;">${brandName} · Christchurch, New Zealand</p>
    <p style="margin:0;">
      <a href="${ctx.unsubscribe_url}" style="color:#8a8a8a;text-decoration:underline;">Unsubscribe</a>
      &nbsp;·&nbsp;
      <a href="${ctx.preferences_url}" style="color:#8a8a8a;text-decoration:underline;">Email preferences</a>
    </p>
  </div>`;
  return `${html}${footer}`;
}

// ── Re-entry policy (pure) ────────────────────────────────────────────────────
// The DB column mkt_flows.re_entry is a boolean (Phase A). The richer 3-value
// policy lives in trigger_config.reEntry; this reconciles the two so old and new
// callers agree. 'never' = one enrollment ever; 'after_exit'/'always' = re-enter
// only once no ACTIVE enrollment exists (the hard "one active per flow+profile"
// rule collapses the last two to the same guard — the distinction is intent).

export type ReEntryPolicy = "never" | "after_exit" | "always";

export function reEntryPolicy(flow: { reEntry?: boolean | null; triggerConfig?: Record<string, any> | null }): ReEntryPolicy {
  const fromConfig = flow.triggerConfig?.reEntry;
  if (fromConfig === "never" || fromConfig === "after_exit" || fromConfig === "always") return fromConfig;
  return flow.reEntry ? "always" : "never";
}
