// TASK TRACKER — the navigable hierarchy (the Projects tab).
//
//   Projects  →  the 8 BRANDS
//     → a brand   →  its DEPARTMENTS (areas), plus any brand-level pages
//       → an area →  the PAGES inside it, and the projects already tagged
//                    to that brand + area
//         → a page → content in a layout chosen PER PAGE
//                    (document · projects · tasks · board · sub-pages)
//
// 🔴 The first two levels are NOT stored rows. Brands come from TT_BRANDS and
// departments from tt_areas — the same tags already on every project. So
// walking the tree and using the flat filters reach exactly the same records:
// this is a way of NAVIGATING the data, never a second copy of it.

import { useMemo, useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  ChevronRight, Plus, FileText, Table2, ListTodo, LayoutGrid, Files,
  Pencil, Trash2, X, ArrowLeft, FolderOpen,
} from "lucide-react";
import {
  BRAND_LABEL, BRAND_SHORT, BRAND_BADGE, isDone, isOverdue, compareTasks,
  type TtBootstrap, type TtProjectRow, type TtTaskRow, type TtAreaRow, type TtStatusRow,
} from "@/lib/task-tracker";
import { ProjectsView, TasksView, TaskRow, StatusPill, AreaChips } from "./task-tracker-views";

// ── Types + navigation state ─────────────────────────────────────────────────

export interface TtPageRow {
  id: number;
  brand: string;
  areaKey: string | null;
  parentId: number | null;
  title: string;
  emoji: string | null;
  description: string | null;
  viewType: "doc" | "projects" | "tasks" | "board" | "list";
  body: string | null;
  sortOrder: number;
}

export type Nav =
  | { level: "brands" }
  | { level: "brand"; brand: string }
  | { level: "area"; brand: string; area: string }
  | { level: "page"; pageId: number };

/** Serialise navigation into the URL hash so a page can be linked and refreshed. */
export function navToHash(n: Nav): string {
  if (n.level === "brands") return "projects";
  if (n.level === "brand") return `projects/${n.brand}`;
  if (n.level === "area") return `projects/${n.brand}/${n.area}`;
  return `page/${n.pageId}`;
}

export function hashToNav(h: string): Nav | null {
  const s = h.replace(/^#/, "");
  if (s === "projects") return { level: "brands" };
  const page = s.match(/^page\/(\d+)$/);
  if (page) return { level: "page", pageId: Number(page[1]) };
  const parts = s.split("/");
  if (parts[0] === "projects" && parts[1] && parts[2]) return { level: "area", brand: parts[1], area: parts[2] };
  if (parts[0] === "projects" && parts[1]) return { level: "brand", brand: parts[1] };
  return null;
}

const VIEW_TYPE_META: Record<TtPageRow["viewType"], { label: string; icon: any; hint: string }> = {
  doc: { label: "Document", icon: FileText, hint: "Written notes" },
  projects: { label: "Projects", icon: Table2, hint: "The projects in this department, as a table" },
  tasks: { label: "Tasks", icon: ListTodo, hint: "Their tasks, as a list" },
  board: { label: "Board", icon: LayoutGrid, hint: "Those tasks as a kanban by status" },
  list: { label: "Sub-pages", icon: Files, hint: "Just the pages nested inside this one" },
};

// ── Small shared pieces ──────────────────────────────────────────────────────

function Crumbs({ items }: { items: Array<{ label: string; onClick?: () => void }> }) {
  return (
    <nav className="flex items-center gap-1 flex-wrap text-[12px] mb-3" aria-label="Breadcrumb">
      {items.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="w-3 h-3 text-white/20 shrink-0" />}
          {c.onClick ? (
            <button onClick={c.onClick} className="text-white/45 hover:text-white/80 transition-colors" data-testid={`crumb-${i}`}>
              {c.label}
            </button>
          ) : (
            <span className="text-white/80 font-medium">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function CountPill({ n, label, plural, tone }: {
  n: number; label: string; plural?: string; tone?: "danger";
}) {
  if (n === 0) return null;
  // "1 pages" reads like a bug. Only count nouns need this — "open" and
  // "overdue" are adjectives and stay as they are.
  const word = n === 1 ? label : (plural ?? label);
  return (
    <span className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded ${
      tone === "danger" ? "text-red-300 bg-red-500/12" : "text-white/45 bg-white/[0.06]"
    }`}>
      {n} {word}
    </span>
  );
}

/**
 * A deliberately small markdown renderer — headings, bold, italic, links, lists,
 * code and paragraphs. No dependency, matching the Market Research page's
 * approach: a page body is notes, not a CMS.
 */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: React.ReactNode[] = [];
    const lines = text.split("\n");
    let list: string[] = [];
    const flush = () => {
      if (list.length) {
        out.push(
          <ul key={`u${out.length}`} className="list-disc pl-5 space-y-1 my-2 text-[13px] text-white/70">
            {list.map((li, i) => <li key={i}>{inline(li)}</li>)}
          </ul>,
        );
        list = [];
      }
    };
    for (const raw of lines) {
      const l = raw.trimEnd();
      if (/^\s*[-*]\s+/.test(l)) { list.push(l.replace(/^\s*[-*]\s+/, "")); continue; }
      flush();
      if (!l.trim()) continue;
      const h = l.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const size = ["text-lg", "text-base", "text-[14px]", "text-[13px]"][h[1].length - 1];
        out.push(<h3 key={out.length} className={`${size} font-semibold text-white/85 mt-4 mb-1`}>{inline(h[2])}</h3>);
        continue;
      }
      out.push(<p key={out.length} className="text-[13px] text-white/70 leading-relaxed my-2">{inline(l)}</p>);
    }
    flush();
    return out;
  }, [text]);
  return <div>{blocks}</div>;
}

function inline(s: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) parts.push(<strong key={k++} className="text-white/90">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) parts.push(<code key={k++} className="px-1 py-0.5 rounded bg-white/[0.08] text-[12px]">{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) {
      const mm = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      parts.push(<a key={k++} href={mm[2]} target="_blank" rel="noreferrer" className="text-blue-300 hover:underline">{mm[1]}</a>);
    } else parts.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

// ── Level 1: the brands ──────────────────────────────────────────────────────

export function BrandsScreen({
  boot, projects, tasks, pages, today, onOpen,
}: {
  boot: TtBootstrap; projects: TtProjectRow[]; tasks: TtTaskRow[]; pages: TtPageRow[];
  today: string; onOpen: (brand: string) => void;
}) {
  const stats = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    return boot.brands.map((b) => {
      const ps = projects.filter((p) => p.brands.includes(b));
      const ids = new Set(ps.map((p) => p.id));
      const ts = tasks.filter((t) => t.projectId != null && ids.has(t.projectId));
      const open = ts.filter((t) => !isDone(t.statusKind));
      return {
        key: b,
        projects: ps.length,
        open: open.length,
        overdue: open.filter((t) => isOverdue(t, today)).length,
        pages: pages.filter((p) => p.brand === b).length,
      };
    });
  }, [boot.brands, projects, tasks, pages, today]);

  return (
    <div>
      <Crumbs items={[{ label: "Projects" }]} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {stats.map((s) => (
          <button
            key={s.key}
            onClick={() => onOpen(s.key)}
            className="text-left rounded-xl border border-white/[0.08] bg-white/[0.025] hover:bg-white/[0.05] hover:border-white/[0.16] transition-colors p-4"
            data-testid={`card-brand-${s.key}`}
          >
            <div className="flex items-center gap-2.5 mb-2">
              <span className="w-9 h-9 rounded-lg bg-blue-500/15 border border-blue-400/20 flex items-center justify-center text-[11px] font-bold text-blue-200 shrink-0">
                {BRAND_BADGE[s.key] ?? s.key.toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-white/85 truncate">{BRAND_LABEL[s.key] ?? s.key}</span>
                <span className="block text-[11px] text-white/35">
                  {s.projects === 0 ? "Nothing yet" : `${s.projects} project${s.projects === 1 ? "" : "s"}`}
                </span>
              </span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <CountPill n={s.open} label="open" />
              <CountPill n={s.overdue} label="overdue" tone="danger" />
              <CountPill n={s.pages} label="page" plural="pages" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Level 2: one brand's departments ─────────────────────────────────────────

export function BrandScreen({
  brand, boot, projects, tasks, pages, today, onBack, onOpenArea, onOpenPage, onAddPage,
}: {
  brand: string; boot: TtBootstrap; projects: TtProjectRow[]; tasks: TtTaskRow[];
  pages: TtPageRow[]; today: string;
  onBack: () => void; onOpenArea: (area: string) => void; onOpenPage: (id: number) => void;
  onAddPage: (brand: string, areaKey: string | null) => void;
}) {
  const brandProjects = projects.filter((p) => p.brands.includes(brand));
  const idsFor = (areaKey: string) =>
    new Set(brandProjects.filter((p) => p.areas.includes(areaKey)).map((p) => p.id));

  const rows = boot.areas.map((a) => {
    const ids = idsFor(a.key);
    const ts = tasks.filter((t) => t.projectId != null && ids.has(t.projectId));
    const open = ts.filter((t) => !isDone(t.statusKind));
    return {
      area: a,
      projects: ids.size,
      open: open.length,
      overdue: open.filter((t) => isOverdue(t, today)).length,
      pages: pages.filter((p) => p.brand === brand && p.areaKey === a.key && p.parentId == null).length,
    };
  });

  // Pages pinned above the departments — the ones that belong to the brand as a
  // whole rather than to any single department.
  const topPages = pages.filter((p) => p.brand === brand && p.areaKey == null && p.parentId == null);

  return (
    <div>
      <Crumbs items={[
        { label: "Projects", onClick: onBack },
        { label: BRAND_LABEL[brand] ?? brand },
      ]} />

      {(topPages.length > 0 || boot.me.isManager) && (
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/40">This brand</h3>
            {boot.me.isManager && (
              <button onClick={() => onAddPage(brand, null)} className="text-[11px] text-blue-300/70 hover:text-blue-300" data-testid="button-add-brand-page">
                + Add page
              </button>
            )}
          </div>
          {topPages.length === 0 ? (
            <p className="text-[12px] text-white/25">No brand-level pages yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {topPages.map((p) => <PageCard key={p.id} page={p} onOpen={() => onOpenPage(p.id)} />)}
            </div>
          )}
        </div>
      )}

      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/40 mb-2">Departments</h3>
      <div className="rounded-xl border border-white/[0.07] overflow-hidden">
        {rows.map((r, i) => (
          <button
            key={r.area.key}
            onClick={() => onOpenArea(r.area.key)}
            className={`w-full text-left flex items-center gap-3 px-3 py-3 hover:bg-white/[0.04] transition-colors ${
              i > 0 ? "border-t border-white/[0.05]" : ""
            }`}
            data-testid={`row-area-${r.area.key}`}
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.area.color }} />
            <span className="flex-1 min-w-0">
              <span className="block text-[13px] text-white/85 truncate">{r.area.label}</span>
              <span className="block text-[11px] text-white/30">
                {r.projects === 0 && r.pages === 0
                  ? "Nothing in here yet"
                  : [r.projects && `${r.projects} project${r.projects === 1 ? "" : "s"}`,
                     r.pages && `${r.pages} page${r.pages === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="flex items-center gap-1.5 shrink-0">
              <CountPill n={r.open} label="open" />
              <CountPill n={r.overdue} label="overdue" tone="danger" />
            </span>
            <ChevronRight className="w-4 h-4 text-white/20 shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}

function PageCard({ page, onOpen }: { page: TtPageRow; onOpen: () => void }) {
  const Icon = VIEW_TYPE_META[page.viewType]?.icon ?? FileText;
  return (
    <button
      onClick={onOpen}
      className="text-left rounded-lg border border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.14] transition-colors px-3 py-2.5 flex items-start gap-2.5"
      data-testid={`card-page-${page.id}`}
    >
      <span className="text-base leading-none pt-0.5">{page.emoji || <Icon className="w-4 h-4 text-white/35" />}</span>
      <span className="min-w-0">
        <span className="block text-[13px] text-white/85 truncate">{page.title}</span>
        {page.description && <span className="block text-[11px] text-white/35 truncate">{page.description}</span>}
      </span>
    </button>
  );
}

// ── Level 3: one department ──────────────────────────────────────────────────

export function AreaScreen({
  brand, area, boot, projects, tasks, pages, today,
  onBack, onBackBrand, onOpenPage, onAddPage, onOpenProject, onOpenTask,
}: {
  brand: string; area: TtAreaRow; boot: TtBootstrap;
  projects: TtProjectRow[]; tasks: TtTaskRow[]; pages: TtPageRow[]; today: string;
  onBack: () => void; onBackBrand: () => void;
  onOpenPage: (id: number) => void; onAddPage: (brand: string, areaKey: string | null) => void;
  onOpenProject: (p: TtProjectRow) => void; onOpenTask: (t: TtTaskRow) => void;
}) {
  const areaProjects = projects.filter((p) => p.brands.includes(brand) && p.areas.includes(area.key));
  const ids = new Set(areaProjects.map((p) => p.id));
  const areaTasks = tasks.filter((t) => t.projectId != null && ids.has(t.projectId));
  const areaPages = pages.filter((p) => p.brand === brand && p.areaKey === area.key && p.parentId == null);

  return (
    <div>
      <Crumbs items={[
        { label: "Projects", onClick: onBack },
        { label: BRAND_LABEL[brand] ?? brand, onClick: onBackBrand },
        { label: area.label },
      ]} />

      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Pages</h3>
        {boot.me.isManager && (
          <button onClick={() => onAddPage(brand, area.key)} className="text-[11px] text-blue-300/70 hover:text-blue-300" data-testid="button-add-area-page">
            + Add page
          </button>
        )}
      </div>
      {areaPages.length === 0 ? (
        <p className="text-[12px] text-white/25 mb-5">
          No pages in here yet{boot.me.isManager ? " — add one for meeting notes, a plan, or a checklist." : "."}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-5">
          {areaPages.map((p) => <PageCard key={p.id} page={p} onOpen={() => onOpenPage(p.id)} />)}
        </div>
      )}

      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/40 mb-2">
        Projects in {area.label}
      </h3>
      {areaProjects.length === 0 ? (
        <p className="text-[12px] text-white/25">
          Nothing tagged to {BRAND_LABEL[brand] ?? brand} + {area.label} yet. Tag a project with both and it appears here.
        </p>
      ) : (
        <ProjectsView
          projects={areaProjects} statuses={boot.projectStatuses} areas={boot.areas}
          today={today} onOpen={onOpenProject}
        />
      )}

      {areaTasks.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/40 mb-2">Tasks</h3>
          <div className="space-y-1.5">
            {areaTasks.sort(compareTasks).map((t) => (
              <TaskRow key={t.id} task={t} today={today} onOpen={onOpenTask} showProject projects={projects} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Level 4: a page ──────────────────────────────────────────────────────────

export function PageScreen({
  page, boot, pages, projects, tasks, today,
  onBack, onBackBrand, onBackArea, onOpenPage, onAddPage, onOpenProject, onOpenTask, onEdit,
}: {
  page: TtPageRow; boot: TtBootstrap; pages: TtPageRow[];
  projects: TtProjectRow[]; tasks: TtTaskRow[]; today: string;
  onBack: () => void; onBackBrand: () => void; onBackArea: () => void;
  onOpenPage: (id: number) => void; onAddPage: (brand: string, areaKey: string | null, parentId: number) => void;
  onOpenProject: (p: TtProjectRow) => void; onOpenTask: (t: TtTaskRow) => void;
  onEdit: () => void;
}) {
  const area = boot.areas.find((a) => a.key === page.areaKey);
  const children = pages.filter((p) => p.parentId === page.id);

  // Content for the data layouts comes from the page's brand + area — the same
  // tags the flat views filter on, so nothing here is a separate dataset.
  const scoped = projects.filter(
    (p) => p.brands.includes(page.brand) && (page.areaKey == null || p.areas.includes(page.areaKey)),
  );
  const ids = new Set(scoped.map((p) => p.id));
  const scopedTasks = tasks.filter((t) => t.projectId != null && ids.has(t.projectId));

  const [draft, setDraft] = useState(page.body ?? "");
  const [editing, setEditing] = useState(false);
  useEffect(() => { setDraft(page.body ?? ""); setEditing(false); }, [page.id, page.body]);

  const saveBody = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/admin/task-tracker/pages/${page.id}`, { body: draft });
      if (!res.ok) throw new Error("Could not save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/task-tracker/pages"] });
      setEditing(false);
    },
  });

  const crumbs = [
    { label: "Projects", onClick: onBack },
    { label: BRAND_LABEL[page.brand] ?? page.brand, onClick: onBackBrand },
    ...(area ? [{ label: area.label, onClick: onBackArea }] : []),
    { label: page.title },
  ];

  return (
    <div>
      <Crumbs items={crumbs} />

      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="text-2xl leading-none">{page.emoji || "📄"}</span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white/90 truncate">{page.title}</h2>
            {page.description && <p className="text-[12px] text-white/40 mt-0.5">{page.description}</p>}
          </div>
        </div>
        {boot.me.isManager && (
          <Button variant="outline" onClick={onEdit} className="h-8 text-[12px]" data-testid="button-edit-page">
            <Pencil className="w-3.5 h-3.5 mr-1" /> Page settings
          </Button>
        )}
      </div>

      {/* ── The chosen layout ─────────────────────────────────────────────── */}
      {page.viewType === "doc" && (
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.015] p-4">
          {editing ? (
            <>
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={16}
                className="text-[13px] font-mono"
                placeholder="Write anything. **bold**, *italic*, # headings, - lists, [links](https://…)"
                data-testid="input-page-body"
              />
              <div className="flex items-center gap-2 mt-3">
                <Button onClick={() => saveBody.mutate()} disabled={saveBody.isPending} className="h-8 text-[12px]" data-testid="button-save-page-body">
                  {saveBody.isPending ? "Saving…" : "Save"}
                </Button>
                <Button variant="ghost" onClick={() => { setDraft(page.body ?? ""); setEditing(false); }} className="h-8 text-[12px]">
                  Cancel
                </Button>
              </div>
            </>
          ) : page.body?.trim() ? (
            <>
              <Markdown text={page.body} />
              <button onClick={() => setEditing(true)} className="mt-3 text-[11px] text-blue-300/70 hover:text-blue-300" data-testid="button-edit-body">
                Edit
              </button>
            </>
          ) : (
            <div className="text-center py-8">
              <FileText className="w-6 h-6 mx-auto text-white/15 mb-2" />
              <p className="text-[13px] text-white/40 mb-3">This page is empty.</p>
              <Button onClick={() => setEditing(true)} className="h-8 text-[12px]" data-testid="button-write-page">Write something</Button>
            </div>
          )}
        </div>
      )}

      {page.viewType === "projects" && (
        scoped.length === 0
          ? <Empty text="No projects carry these tags yet." />
          : <ProjectsView projects={scoped} statuses={boot.projectStatuses} areas={boot.areas} today={today} onOpen={onOpenProject} />
      )}

      {page.viewType === "tasks" && (
        scopedTasks.length === 0
          ? <Empty text="No tasks under these projects yet." />
          : <div className="space-y-1.5">
              {scopedTasks.sort(compareTasks).map((t) => (
                <TaskRow key={t.id} task={t} today={today} onOpen={onOpenTask} showProject projects={projects} />
              ))}
            </div>
      )}

      {page.viewType === "board" && (
        <BoardLayout statuses={boot.taskStatuses} tasks={scopedTasks} today={today} projects={projects} onOpen={onOpenTask} />
      )}

      {/* ── Nested pages (always shown; the only content of a 'list' page) ── */}
      {(children.length > 0 || page.viewType === "list" || boot.me.isManager) && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Inside this page</h3>
            {boot.me.isManager && (
              <button
                onClick={() => onAddPage(page.brand, page.areaKey, page.id)}
                className="text-[11px] text-blue-300/70 hover:text-blue-300"
                data-testid="button-add-child-page"
              >
                + Add page
              </button>
            )}
          </div>
          {children.length === 0 ? (
            <p className="text-[12px] text-white/25">Nothing nested in here yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {children.map((c) => <PageCard key={c.id} page={c} onOpen={() => onOpenPage(c.id)} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="text-center py-10 rounded-xl border border-white/[0.06] bg-white/[0.015]">
      <FolderOpen className="w-6 h-6 mx-auto text-white/15 mb-2" />
      <p className="text-[13px] text-white/40">{text}</p>
    </div>
  );
}

function BoardLayout({
  statuses, tasks, today, projects, onOpen,
}: {
  statuses: TtStatusRow[]; tasks: TtTaskRow[]; today: string;
  projects: TtProjectRow[]; onOpen: (t: TtTaskRow) => void;
}) {
  if (tasks.length === 0) return <Empty text="No tasks to show on the board yet." />;
  return (
    // Horizontal scroll is owned by this wrapper so the PAGE never scrolls
    // sideways on a phone — the house containment rule.
    <div className="overflow-x-auto -mx-1 px-1">
      <div className="flex gap-3 min-w-max pb-2">
        {statuses.map((st) => {
          const col = tasks.filter((t) => t.statusId === st.id).sort(compareTasks);
          return (
            <div key={st.id} className="w-[260px] shrink-0">
              <div className="flex items-center gap-2 mb-2">
                <StatusPill label={st.label} color={st.color} />
                <span className="text-[11px] text-white/30 tabular-nums">{col.length}</span>
              </div>
              <div className="space-y-1.5">
                {col.map((t) => (
                  <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} showProject projects={projects} />
                ))}
                {col.length === 0 && (
                  <div className="rounded-lg border border-dashed border-white/[0.07] py-6 text-center text-[11px] text-white/20">
                    Empty
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Page settings modal (managers) ───────────────────────────────────────────

export function PageModal({
  boot, initial, defaults, onClose, onSaved, toast,
}: {
  boot: TtBootstrap;
  initial?: TtPageRow;
  defaults?: { brand: string; areaKey: string | null; parentId?: number };
  onClose: () => void;
  onSaved: (p: TtPageRow, deleted?: boolean) => void;
  toast: any;
}) {
  const editing = !!initial;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [viewType, setViewType] = useState<TtPageRow["viewType"]>(initial?.viewType ?? "doc");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/task-tracker/pages"] });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { title, emoji, description, viewType };
      if (!editing) {
        body.brand = defaults!.brand;
        body.areaKey = defaults!.areaKey;
        if (defaults!.parentId) body.parentId = defaults!.parentId;
      }
      const res = editing
        ? await apiRequest("PATCH", `/api/admin/task-tracker/pages/${initial!.id}`, body)
        : await apiRequest("POST", "/api/admin/task-tracker/pages", body);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Could not save");
      return res.json();
    },
    onSuccess: (p) => { invalidate(); onSaved(p); onClose(); },
    onError: (e: any) => toast({ title: "Not saved", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/admin/task-tracker/pages/${initial!.id}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Could not delete");
      return res.json();
    },
    onSuccess: (r: any) => {
      invalidate();
      if (r?.archived) {
        toast({
          title: "Archived instead of deleted",
          description: `This still has ${r.childCount} page${r.childCount === 1 ? "" : "s"} inside it, so it was kept.`,
        });
      }
      onSaved(initial!, true);
      onClose();
    },
    onError: (e: any) => toast({ title: "Not deleted", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex overflow-y-auto p-3 sm:p-6" onClick={onClose}>
      <div className="m-auto w-full max-w-lg rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-white/[0.07]">
          <h2 className="text-[14px] font-semibold text-white/85">{editing ? "Page settings" : "New page"}</h2>
          <button onClick={onClose} className="text-white/35 hover:text-white/70 p-1" data-testid="button-close-page-modal">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 sm:px-5 py-4 space-y-3">
          <div className="flex gap-2">
            <div className="w-16 shrink-0">
              <Label className="text-[11px] text-white/45 mb-1 block">Icon</Label>
              <Input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="📄" maxLength={4} className="text-center text-[15px]" data-testid="input-page-emoji" />
            </div>
            <div className="flex-1 min-w-0">
              <Label className="text-[11px] text-white/45 mb-1 block">Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly meeting notes" className="text-[13px]" autoFocus data-testid="input-page-title" />
            </div>
          </div>

          <div>
            <Label className="text-[11px] text-white/45 mb-1 block">Subtitle <span className="text-white/25">(optional)</span></Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} className="text-[13px]" data-testid="input-page-description" />
          </div>

          <div>
            <Label className="text-[11px] text-white/45 mb-1.5 block">How should this page look?</Label>
            <div className="space-y-1.5">
              {(Object.keys(VIEW_TYPE_META) as Array<TtPageRow["viewType"]>).map((k) => {
                const m = VIEW_TYPE_META[k];
                const on = viewType === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setViewType(k)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors ${
                      on ? "bg-blue-500/12 border-blue-500/30" : "bg-white/[0.02] border-white/[0.08] hover:bg-white/[0.05]"
                    }`}
                    data-testid={`option-viewtype-${k}`}
                  >
                    <m.icon className={`w-4 h-4 shrink-0 ${on ? "text-blue-300" : "text-white/35"}`} />
                    <span className="min-w-0">
                      <span className={`block text-[12px] font-medium ${on ? "text-blue-200" : "text-white/75"}`}>{m.label}</span>
                      <span className="block text-[11px] text-white/35">{m.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 sm:px-5 pb-4">
          <Button onClick={() => save.mutate()} disabled={!title.trim() || save.isPending} className="h-9 text-[12px]" data-testid="button-save-page">
            {save.isPending ? "Saving…" : editing ? "Save" : "Add page"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="h-9 text-[12px]">Cancel</Button>
          {editing && (
            <Button variant="ghost" onClick={() => remove.mutate()} className="h-9 text-[12px] text-red-300/70 hover:text-red-300 ml-auto" data-testid="button-delete-page">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
