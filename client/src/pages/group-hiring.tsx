// ─────────────────────────────────────────────────────────────────────────────
// HIRING — the "Hiring" tab in the United Sports Group workspace of ClubOS.
//
// Two views: a jobs list (cards, one per posting) and an applicant pipeline for
// a selected job (stat-chip filters + expandable rows, the review surface for
// moving someone from "new" through to "hired"). Status lists, question types
// and hard limits all come from @shared/hiring — never redeclared here.
//
// House style copied from feedback.tsx (stat chips that double as filters, a
// shadcn Dialog for create/edit, inline <select> mutations, dark-glass
// Tailwind) and group-content.tsx (how a group-workspace page reads/writes
// against react-query + apiRequest). Admin routes are org-scoped by the
// X-Workspace-Slug header, which apiRequest / the default queryFn attach
// automatically from localStorage — no explicit header wiring needed here.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Briefcase, Plus, Search, Trash2, ArrowLeft, Pencil, MapPin, Wallet,
  Star, ShieldAlert, Download, ExternalLink, Check, Users,
} from "lucide-react";
import {
  APPLICATION_STATUSES,
  JOB_STATUSES,
  QUESTION_TYPES,
  HIRING_LIMITS,
  ageOnDate,
  type ApplicationStatus,
  type JobStatus,
  type QuestionType,
  type HiringQuestion,
} from "@shared/hiring";

// ── Types (mirror server/hiring-routes.ts response shapes) ──────────────────
interface HiringJob {
  id: number;
  organizationId: number;
  brand: string;
  slug: string;
  title: string;
  tagline: string | null;
  description: string | null;
  employmentType: string | null;
  positions: number;
  payLabel: string | null;
  location: string | null;
  status: JobStatus;
  closesAt: string | null;
  advertUrl: string | null;
  notifyEmail: string | null;
  questions: HiringQuestion[];
  createdAt: string;
  open: boolean;
  applicationCount: number;
  newCount: number;
  hiredCount: number;
}

interface HiringApplication {
  id: number;
  jobId: number;
  jobTitle: string;
  jobSlug: string;
  firstName: string;
  lastName: string | null;
  email: string;
  phone: string;
  dateOfBirth: string;
  city: string | null;
  guardianRequired: boolean;
  guardianName: string | null;
  guardianRelationship: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  guardianConsent: boolean;
  answers: Record<string, string | boolean>;
  auditionUrl: string | null;
  auditionFilename: string | null;
  auditionMime: string | null;
  auditionBytes: number | null;
  hasAuditionFile: boolean;
  status: ApplicationStatus;
  rating: number | null;
  reviewerNotes: string | null;
  reviewerName: string | null;
  decidedAt: string | null;
  createdAt: string;
}

// ── Config ───────────────────────────────────────────────────────────────────
const JOB_STATUS_META: Record<JobStatus, { label: string; color: string }> = {
  draft: { label: "Draft", color: "#6b7280" },
  open: { label: "Open", color: "#22c55e" },
  closed: { label: "Closed", color: "#ef4444" },
};

const APPLICATION_STATUS_META: Record<ApplicationStatus, { label: string; color: string }> = {
  new: { label: "New", color: "#3b82f6" },
  reviewing: { label: "Reviewing", color: "#eab308" },
  shortlisted: { label: "Shortlisted", color: "#a855f7" },
  trial: { label: "Trial", color: "#06b6d4" },
  offered: { label: "Offered", color: "#f97316" },
  hired: { label: "Hired", color: "#22c55e" },
  declined: { label: "Declined", color: "#6b7280" },
  withdrawn: { label: "Withdrawn", color: "#64748b" },
};

const BRAND_COLORS: Record<string, string> = {
  cufc: "#3b82f6", mfl: "#d1b96e", cic: "#c9a43e", siu: "#14b8a6",
  cugc: "#8b5cf6", unitedprints: "#06b6d4", footballinstitute: "#22c55e",
  usg: "#eab308",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const slugify = (v: string) =>
  v.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");

const fmtDateNZ = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";

const fmtRelative = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return fmtDateNZ(iso);
};

/** Best-effort extraction of the server's JSON `message` out of an apiRequest error. */
function apiErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "Something went wrong");
  const idx = raw.indexOf(": ");
  const body = idx >= 0 ? raw.slice(idx + 2) : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return raw;
}

function closesText(job: HiringJob): string {
  if (job.status === "draft") return "Draft — not published";
  if (!job.open) return "Closed";
  if (!job.closesAt) return "Open";
  const days = Math.ceil((new Date(job.closesAt).getTime() - Date.now()) / 86400000);
  if (days <= 0) return "Closes today";
  if (days === 1) return "Closes tomorrow";
  return `Closes in ${days} days`;
}

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 disabled:opacity-40 disabled:cursor-not-allowed";
const selectCls = "rounded-lg bg-white/[0.04] border border-white/10 px-2 py-1 text-[11px] text-white/80 focus:outline-none focus:border-blue-500/50 cursor-pointer";

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {label}
    </span>
  );
}

function BrandBadge({ brand }: { brand: string }) {
  const color = BRAND_COLORS[brand] || "#64748b";
  return (
    <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: `${color}22`, color }}>
      {brand}
    </span>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export default function GroupHiring() {
  const { toast } = useToast();
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [jobDialogOpen, setJobDialogOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<HiringJob | undefined>(undefined);

  const { data: jobsData, isLoading: jobsLoading } = useQuery<{ jobs: HiringJob[]; allowedBrands: string[] | null }>({
    queryKey: ["/api/admin/hiring/jobs"],
  });
  const jobs = jobsData?.jobs ?? [];
  // null = every brand. A scoped viewer (e.g. the person who runs Mini Football
  // and the CIC) only ever sees, edits and posts under their own brands — the
  // server enforces it; this just keeps the UI from offering what it would reject.
  const allowedBrands = jobsData?.allowedBrands ?? null;
  const selectedJob = selectedJobId != null ? jobs.find((j) => j.id === selectedJobId) : undefined;

  const invalidateJobs = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/hiring/jobs"] });

  const createJobMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiRequest("POST", "/api/admin/hiring/jobs", body),
    onSuccess: () => {
      invalidateJobs();
      setJobDialogOpen(false);
      toast({ title: "Job posted" });
    },
    onError: (e: unknown) => toast({ title: "Couldn't create job", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const updateJobMut = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) =>
      apiRequest("PATCH", `/api/admin/hiring/jobs/${id}`, body),
    onSuccess: () => {
      invalidateJobs();
      setJobDialogOpen(false);
      toast({ title: "Job saved" });
    },
    onError: (e: unknown) => toast({ title: "Couldn't save job", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const patchJobStatusMut = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      apiRequest("PATCH", `/api/admin/hiring/jobs/${id}`, { status }),
    onSuccess: () => invalidateJobs(),
    onError: (e: unknown) => toast({ title: "Couldn't update status", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const deleteJobMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/hiring/jobs/${id}`),
    onSuccess: () => {
      invalidateJobs();
      toast({ title: "Job deleted" });
    },
    onError: (e: unknown) => toast({ title: "Couldn't delete job", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const openCreate = () => { setEditingJob(undefined); setJobDialogOpen(true); };
  const openEdit = (job: HiringJob) => { setEditingJob(job); setJobDialogOpen(true); };

  if (selectedJob) {
    return (
      <>
        <ApplicantPipeline
          job={selectedJob}
          onBack={() => setSelectedJobId(null)}
          onEditJob={() => openEdit(selectedJob)}
        />
        <JobDialogRoot
          open={jobDialogOpen}
          onOpenChange={setJobDialogOpen}
          job={editingJob}
          saving={createJobMut.isPending || updateJobMut.isPending}
          allowedBrands={allowedBrands}
          onSubmit={(body) => {
            if (editingJob) updateJobMut.mutate({ id: editingJob.id, ...body });
            else createJobMut.mutate(body);
          }}
        />
      </>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto text-white/90">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Briefcase className="w-5 h-5 text-blue-400" /> Hiring
          </h1>
          <p className="text-[13px] text-white/40 mt-1 max-w-xl">
            Post a role, share the advert, and move applicants through the pipeline — from first application to hired.
          </p>
        </div>
        <button
          onClick={openCreate}
          data-testid="button-new-job"
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 px-4 py-2 text-sm font-medium hover:bg-blue-500/25 transition-colors"
        >
          <Plus className="w-4 h-4" /> New job
        </button>
      </div>

      {jobsLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
      ) : !jobs.length ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <Briefcase className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm">No roles posted yet.</div>
          <button onClick={openCreate} className="text-blue-400 text-[13px] mt-2 hover:underline">
            Post the first one →
          </button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onOpen={() => setSelectedJobId(job.id)}
              onEdit={() => openEdit(job)}
              onDelete={() => {
                if (confirm(`Delete "${job.title}"? This can't be undone.`)) deleteJobMut.mutate(job.id);
              }}
              onStatusChange={(status) => patchJobStatusMut.mutate({ id: job.id, status })}
            />
          ))}
        </div>
      )}

      <JobDialogRoot
        open={jobDialogOpen}
        onOpenChange={setJobDialogOpen}
        job={editingJob}
        saving={createJobMut.isPending || updateJobMut.isPending}
        allowedBrands={allowedBrands}
        onSubmit={(body) => {
          if (editingJob) updateJobMut.mutate({ id: editingJob.id, ...body });
          else createJobMut.mutate(body);
        }}
      />
    </div>
  );
}

// ═══ JOB CARD ══════════════════════════════════════════════════════════════
function JobCard({ job, onOpen, onEdit, onDelete, onStatusChange }: {
  job: HiringJob;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatusChange: (status: string) => void;
}) {
  const meta = JOB_STATUS_META[job.status] ?? JOB_STATUS_META.draft;
  return (
    <div
      onClick={onOpen}
      data-testid={`card-job-${job.id}`}
      className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 hover:border-white/10 transition-colors cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <BrandBadge brand={job.brand} />
            <Pill label={meta.label} color={meta.color} />
          </div>
          <div className="font-semibold text-[15px] text-white/90 truncate">{job.title}</div>
          {job.tagline && <div className="text-[12px] text-white/40 truncate">{job.tagline}</div>}
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button onClick={onEdit} className="w-7 h-7 rounded-lg text-white/30 hover:text-white hover:bg-white/[0.06] flex items-center justify-center" title="Edit">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete} className="w-7 h-7 rounded-lg text-white/30 hover:text-red-400 hover:bg-white/[0.06] flex items-center justify-center" title="Delete">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap text-[12px] text-white/50 mb-3">
        <span>{job.positions} position{job.positions === 1 ? "" : "s"}</span>
        {job.payLabel && <span className="flex items-center gap-1"><Wallet className="w-3 h-3" />{job.payLabel}</span>}
        {job.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{job.location}</span>}
      </div>

      <div className="flex items-center justify-between text-[11px]">
        <span className={job.open ? "text-emerald-300/80" : job.status === "draft" ? "text-white/30" : "text-red-300/70"}>
          {closesText(job)}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-white/40">{job.applicationCount} applied</span>
          {job.newCount > 0 && <span className="text-blue-300">{job.newCount} new</span>}
          {job.hiredCount > 0 && <span className="text-emerald-300">{job.hiredCount} hired</span>}
        </div>
      </div>

      <div className="mt-2.5 pt-2.5 border-t border-white/[0.06]" onClick={(e) => e.stopPropagation()}>
        <select
          value={job.status}
          onChange={(e) => onStatusChange(e.target.value)}
          data-testid={`select-job-status-${job.id}`}
          className={selectCls}
        >
          {JOB_STATUSES.map((s) => <option key={s} value={s}>{JOB_STATUS_META[s].label}</option>)}
        </select>
      </div>
    </div>
  );
}

// ═══ JOB CREATE/EDIT DIALOG ═══════════════════════════════════════════════════
function JobDialogRoot({ open, onOpenChange, job, saving, onSubmit, allowedBrands }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  job: HiringJob | undefined;
  saving: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
  allowedBrands: string[] | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
        <JobForm
          key={job?.id ?? "new"}
          job={job}
          saving={saving}
          allowedBrands={allowedBrands}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

function JobForm({ job, saving, onCancel, onSubmit, allowedBrands }: {
  job: HiringJob | undefined;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  allowedBrands: string[] | null;
}) {
  const isEdit = !!job;
  const [title, setTitle] = useState(job?.title ?? "");
  // A scoped user gets a picker of their own brands, pre-filled when there is
  // only one — typing "cufc" into a free-text box only to be refused on save is
  // a worse way to learn the rule.
  const [brand, setBrand] = useState(job?.brand ?? (allowedBrands?.length === 1 ? allowedBrands[0] : ""));
  const [slug, setSlug] = useState(job?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [tagline, setTagline] = useState(job?.tagline ?? "");
  const [description, setDescription] = useState(job?.description ?? "");
  const [employmentType, setEmploymentType] = useState(job?.employmentType ?? "");
  const [positions, setPositions] = useState(String(job?.positions ?? 1));
  const [payLabel, setPayLabel] = useState(job?.payLabel ?? "");
  const [location, setLocation] = useState(job?.location ?? "");
  const [status, setStatus] = useState<JobStatus>(job?.status ?? "draft");
  const [closesAt, setClosesAt] = useState(job?.closesAt ? job.closesAt.slice(0, 10) : "");
  const [advertUrl, setAdvertUrl] = useState(job?.advertUrl ?? "");
  const [notifyEmail, setNotifyEmail] = useState(job?.notifyEmail ?? "");
  const [questions, setQuestions] = useState<HiringQuestion[]>(job?.questions ?? []);

  const handleTitleChange = (v: string) => {
    setTitle(v);
    if (!isEdit && !slugTouched) setSlug(slugify(v));
  };

  const canSubmit = title.trim() !== "" && brand.trim() !== "" && slug.trim() !== "";

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      title: title.trim(),
      brand: brand.trim().toLowerCase(),
      slug: slug.trim().toLowerCase(),
      tagline: tagline.trim() || null,
      description: description.trim() || null,
      employmentType: employmentType.trim() || null,
      positions: Math.max(1, Number(positions) || 1),
      payLabel: payLabel.trim() || null,
      location: location.trim() || null,
      status,
      closesAt: closesAt || null,
      advertUrl: advertUrl.trim() || null,
      notifyEmail: notifyEmail.trim() || null,
      questions,
    });
  };

  return (
    <>
      <div className="mb-1">
        <h2 className="text-base font-semibold">{isEdit ? "Edit job" : "New job"}</h2>
      </div>

      <div className="space-y-2.5">
        <div>
          <label className="text-[11px] text-white/40 mb-1 block">Title *</label>
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="e.g. Club Commentator"
            data-testid="input-job-title"
            className={inputCls}
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Brand *</label>
            {allowedBrands ? (
              <select
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                disabled={isEdit}
                data-testid="input-job-brand"
                /* inputCls, not selectCls: this sits beside the full-width slug
                   field, and selectCls is the small inline status pill. */
                className={inputCls}
              >
                <option value="">Choose…</option>
                {/* An existing job's brand stays listed even if it sits outside
                    the current scope, so an edit dialog can never blank it. */}
                {Array.from(new Set([...allowedBrands, ...(job?.brand ? [job.brand] : [])])).map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            ) : (
              <input
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="cufc, mfl, siu, cic…"
                disabled={isEdit}
                data-testid="input-job-brand"
                className={inputCls}
              />
            )}
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">URL slug *</label>
            <input
              value={slug}
              onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
              placeholder="club-commentator"
              disabled={isEdit}
              data-testid="input-job-slug"
              className={inputCls}
            />
          </div>
        </div>
        {isEdit && <p className="text-[11px] text-white/25 -mt-1">Brand and slug are set at creation and can't be changed — they're part of the shared advert link.</p>}

        <div>
          <label className="text-[11px] text-white/40 mb-1 block">Tagline</label>
          <input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="One line under the title" className={inputCls} />
        </div>

        <div>
          <label className="text-[11px] text-white/40 mb-1 block">Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls + " min-h-[90px]"} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Employment type</label>
            <input value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} placeholder="Casual / Contract" className={inputCls} />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Positions</label>
            <input type="number" min={1} value={positions} onChange={(e) => setPositions(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Pay</label>
            <input value={payLabel} onChange={(e) => setPayLabel(e.target.value)} placeholder="$25/hr, Volunteer…" className={inputCls} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Location</label>
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. English Park" className={inputCls} />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as JobStatus)} className={inputCls + " cursor-pointer"}>
              {JOB_STATUSES.map((s) => <option key={s} value={s}>{JOB_STATUS_META[s].label}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Closes</label>
            <input type="date" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Notify email</label>
            <input value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)} placeholder="who gets emailed" className={inputCls} />
          </div>
        </div>

        <div>
          <label className="text-[11px] text-white/40 mb-1 block">Advert URL</label>
          <input value={advertUrl} onChange={(e) => setAdvertUrl(e.target.value)} placeholder="https://…/careers/…" className={inputCls} />
        </div>

        <div className="border-t border-white/[0.06] pt-3">
          <div className="text-[11px] uppercase tracking-wider text-white/40 font-semibold mb-2">Application questions</div>
          <QuestionsEditor questions={questions} onChange={setQuestions} />
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
        <button
          onClick={submit}
          disabled={!canSubmit || saving}
          data-testid="button-submit-job"
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50 transition-colors"
        >
          <Check className="w-4 h-4" /> {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}

function QuestionsEditor({ questions, onChange }: {
  questions: HiringQuestion[];
  onChange: (qs: HiringQuestion[]) => void;
}) {
  const update = (i: number, patch: Partial<HiringQuestion>) => {
    const next = questions.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const remove = (i: number) => onChange(questions.filter((_, idx) => idx !== i));
  const add = () => {
    if (questions.length >= HIRING_LIMITS.maxQuestions) return;
    onChange([...questions, { id: `q${Date.now().toString(36)}`, label: "", type: "text", required: false }]);
  };

  return (
    <div className="space-y-2">
      {questions.map((q, i) => (
        <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-1.5">
          <div className="grid grid-cols-[1fr_120px_auto] gap-2">
            <input
              value={q.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Question label"
              className={inputCls}
            />
            <select
              value={q.type}
              onChange={(e) => update(i, { type: e.target.value as QuestionType })}
              className={inputCls + " cursor-pointer"}
            >
              {QUESTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button type="button" onClick={() => remove(i)} className="text-white/30 hover:text-red-400 px-1" title="Remove question">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-[11px] text-white/50">
              <input type="checkbox" checked={!!q.required} onChange={(e) => update(i, { required: e.target.checked })} className="accent-blue-500" />
              Required
            </label>
            <input
              value={q.id}
              onChange={(e) => update(i, { id: e.target.value.replace(/[^a-zA-Z0-9_-]/g, "") })}
              placeholder="id (unique key)"
              className={inputCls + " max-w-[160px] text-[11px]"}
            />
            {q.type === "select" && (
              <input
                value={(q.options ?? []).join(", ")}
                onChange={(e) => update(i, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })}
                placeholder="Options, comma separated"
                className={inputCls + " flex-1 min-w-[160px]"}
              />
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        disabled={questions.length >= HIRING_LIMITS.maxQuestions}
        className="inline-flex items-center gap-1.5 text-[12px] text-blue-300 hover:text-blue-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus className="w-3.5 h-3.5" /> Add question{questions.length >= HIRING_LIMITS.maxQuestions ? ` (max ${HIRING_LIMITS.maxQuestions})` : ""}
      </button>
    </div>
  );
}

// ═══ APPLICANT PIPELINE ═══════════════════════════════════════════════════════
function ApplicantPipeline({ job, onBack, onEditJob }: {
  job: HiringJob;
  onBack: () => void;
  onEditJob: () => void;
}) {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const queryKey = [`/api/admin/hiring/applications?jobId=${job.id}`];
  const { data, isLoading } = useQuery<{ applications: HiringApplication[] }>({ queryKey });
  const applications = data?.applications ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const updateMut = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) =>
      apiRequest("PATCH", `/api/admin/hiring/applications/${id}`, body),
    onSuccess: () => invalidate(),
    onError: (e: unknown) => toast({ title: "Update failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/hiring/applications/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ title: "Application removed" });
    },
    onError: (e: unknown) => toast({ title: "Couldn't delete", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const st of APPLICATION_STATUSES) c[st] = 0;
    for (const a of applications) c[a.status] = (c[a.status] || 0) + 1;
    return c;
  }, [applications]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return applications.filter((a) => {
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (q) {
        const hay = `${a.firstName} ${a.lastName ?? ""} ${a.email} ${a.phone} ${a.city ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [applications, statusFilter, search]);

  const jobMeta = JOB_STATUS_META[job.status] ?? JOB_STATUS_META.draft;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto text-white/90">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[13px] text-white/40 hover:text-white/70 mb-3">
        <ArrowLeft className="w-3.5 h-3.5" /> All jobs
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <BrandBadge brand={job.brand} />
            <Pill label={jobMeta.label} color={jobMeta.color} />
          </div>
          <h1 className="text-xl font-semibold">{job.title}</h1>
          <p className="text-[13px] text-white/40 mt-1">
            {closesText(job)} · {job.applicationCount} application{job.applicationCount === 1 ? "" : "s"}
          </p>
        </div>
        <button
          onClick={onEditJob}
          className="inline-flex items-center gap-2 rounded-xl bg-white/[0.04] border border-white/10 text-white/70 px-3 py-2 text-sm font-medium hover:bg-white/[0.08] transition-colors shrink-0"
        >
          <Pencil className="w-3.5 h-3.5" /> Edit job
        </button>
      </div>

      {/* stat chips — filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        {APPLICATION_STATUSES.map((st) => {
          const meta = APPLICATION_STATUS_META[st];
          const active = statusFilter === st;
          return (
            <button
              key={st}
              onClick={() => setStatusFilter(active ? "all" : st)}
              data-testid={`filter-status-${st}`}
              className="rounded-xl border px-3 py-2 text-left transition-colors"
              style={{
                borderColor: active ? `${meta.color}88` : "rgba(255,255,255,0.06)",
                background: active ? `${meta.color}18` : "rgba(255,255,255,0.02)",
              }}
            >
              <div className="text-[10px] font-medium" style={{ color: meta.color }}>{meta.label}</div>
              <div className="text-lg font-semibold mt-0.5">{counts[st] || 0}</div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 mb-4">
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, phone, city…"
            data-testid="input-search-applicants"
            className="rounded-lg bg-white/[0.03] border border-white/10 pl-8 pr-3 py-1.5 text-[13px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 w-full sm:w-72"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
      ) : !filtered.length ? (
        <EmptyApplicants job={job} anyApplications={applications.length > 0} />
      ) : (
        <div className="space-y-2">
          {filtered.map((app) => (
            <ApplicantCard
              key={app.id}
              app={app}
              job={job}
              expanded={expandedId === app.id}
              onToggle={() => setExpandedId(expandedId === app.id ? null : app.id)}
              onUpdate={(body) => updateMut.mutate({ id: app.id, ...body })}
              onDelete={() => {
                if (confirm(`Delete ${app.firstName}'s application?`)) deleteMut.mutate(app.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyApplicants({ job, anyApplications }: { job: HiringJob; anyApplications: boolean }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
      <Users className="w-8 h-8 text-white/20 mx-auto mb-3" />
      <div className="text-white/50 text-sm">{anyApplications ? "Nothing matches your filters." : "No applications yet."}</div>
      {!anyApplications && (
        job.advertUrl ? (
          <div className="text-[13px] text-white/40 mt-2">
            Share the advert: <a href={job.advertUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{job.advertUrl}</a>
          </div>
        ) : (
          <div className="text-[13px] text-white/30 mt-2">Add an advert URL by editing the job, then share it.</div>
        )
      )}
    </div>
  );
}

function StarRating({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={(e) => { e.stopPropagation(); onChange(value === n ? null : n); }}
          className="p-0.5"
          title={`Rate ${n}`}
        >
          <Star className={`w-3.5 h-3.5 ${value != null && n <= value ? "fill-amber-400 text-amber-400" : "text-white/20"}`} />
        </button>
      ))}
    </div>
  );
}

function AnswerList({ app, questions }: { app: HiringApplication; questions: HiringQuestion[] }) {
  const keys = Object.keys(app.answers || {});
  if (!keys.length) return <div className="text-[12px] text-white/30">No extra answers submitted.</div>;
  return (
    <div className="space-y-2.5">
      {keys.map((k) => {
        const q = questions.find((qq) => qq.id === k);
        const label = q?.label || k;
        const val = app.answers[k];
        return (
          <div key={k}>
            <div className="text-[11px] text-white/40 mb-0.5">{label}</div>
            {typeof val === "boolean" ? (
              <div className="text-[13px] text-white/85">{val ? "✓" : "✗"}</div>
            ) : q?.type === "textarea" ? (
              <div className="text-[13px] text-white/85 whitespace-pre-wrap bg-white/[0.03] rounded-lg p-2.5 border border-white/[0.06]">{String(val)}</div>
            ) : q?.type === "url" ? (
              <a href={String(val)} target="_blank" rel="noreferrer" className="text-[13px] text-blue-400 hover:underline break-all">{String(val)}</a>
            ) : (
              <div className="text-[13px] text-white/85 break-words">{String(val)}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ApplicantCard({ app, job, expanded, onToggle, onUpdate, onDelete }: {
  app: HiringApplication;
  job: HiringJob;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (body: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const meta = APPLICATION_STATUS_META[app.status] ?? APPLICATION_STATUS_META.new;
  const age = ageOnDate(app.dateOfBirth, new Date());

  return (
    <div data-testid={`card-applicant-${app.id}`} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] hover:border-white/10 transition-colors">
      <div className="p-4 cursor-pointer" onClick={onToggle}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-[14px] text-white/90">{app.firstName} {app.lastName ?? ""}</span>
              <Pill label={meta.label} color={meta.color} />
              {app.guardianRequired && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/40">
                  <ShieldAlert className="w-3 h-3" /> Under 16 — guardian consent
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap mt-1 text-[12px] text-white/45">
              {age != null && <span>{age} yrs</span>}
              {app.city && <span>{app.city}</span>}
              <span>{app.email}</span>
              <span>{app.phone}</span>
              <span className="text-white/30">· {fmtRelative(app.createdAt)}</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
            <select
              value={app.status}
              onChange={(e) => onUpdate({ status: e.target.value })}
              data-testid={`select-app-status-${app.id}`}
              className={selectCls}
            >
              {APPLICATION_STATUSES.map((st) => <option key={st} value={st}>{APPLICATION_STATUS_META[st].label}</option>)}
            </select>
            <StarRating value={app.rating} onChange={(v) => onUpdate({ rating: v })} />
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-white/[0.06] pt-3 space-y-3" onClick={(e) => e.stopPropagation()}>
          {app.guardianRequired && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
              <div className="text-[11px] font-semibold text-amber-300 mb-1.5 flex items-center gap-1">
                <ShieldAlert className="w-3.5 h-3.5" /> Contact the guardian, not the applicant directly
              </div>
              <div className="text-[13px] text-white/80 space-y-0.5">
                <div>{app.guardianName || "—"}{app.guardianRelationship ? ` (${app.guardianRelationship})` : ""}</div>
                <div className="text-white/60">{app.guardianEmail || "—"} · {app.guardianPhone || "—"}</div>
                <div className="text-[11px] text-white/40 mt-1">Consent given: {app.guardianConsent ? "Yes" : "No"}</div>
              </div>
            </div>
          )}

          <div>
            <div className="text-[11px] text-white/30 uppercase tracking-wider mb-1">Applicant</div>
            <div className="text-[13px] text-white/70">{app.email} · {app.phone}</div>
            {app.city && <div className="text-[13px] text-white/50">{app.city}</div>}
          </div>

          {(app.hasAuditionFile || app.auditionUrl) && (
            <div>
              <div className="text-[11px] text-white/30 uppercase tracking-wider mb-1.5">Audition</div>
              {app.hasAuditionFile && (
                <div className="space-y-1.5">
                  {app.auditionMime?.startsWith("audio/") ? (
                    <audio controls src={`/api/admin/hiring/applications/${app.id}/audition`} className="w-full" />
                  ) : (
                    <video controls src={`/api/admin/hiring/applications/${app.id}/audition`} className="w-full max-h-72 rounded-lg bg-black" />
                  )}
                  <a
                    href={`/api/admin/hiring/applications/${app.id}/audition?download=1`}
                    className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:underline"
                  >
                    <Download className="w-3 h-3" /> Download{app.auditionFilename ? ` · ${app.auditionFilename}` : ""}
                  </a>
                </div>
              )}
              {app.auditionUrl && (
                <a href={app.auditionUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-blue-400 hover:underline mt-1">
                  <ExternalLink className="w-3 h-3" /> {app.auditionUrl}
                </a>
              )}
            </div>
          )}

          <div>
            <div className="text-[11px] text-white/30 uppercase tracking-wider mb-1.5">Answers</div>
            <AnswerList app={app} questions={job.questions} />
          </div>

          <div>
            <div className="text-[11px] text-white/30 uppercase tracking-wider mb-1.5">Reviewer notes</div>
            <textarea
              key={app.reviewerNotes ?? ""}
              defaultValue={app.reviewerNotes ?? ""}
              placeholder="Notes for the team…"
              data-testid={`textarea-notes-${app.id}`}
              className={inputCls + " min-h-[60px]"}
              onBlur={(e) => {
                if (e.target.value !== (app.reviewerNotes ?? "")) onUpdate({ reviewerNotes: e.target.value });
              }}
            />
            {app.reviewerName && (
              <div className="text-[10px] text-white/30 mt-1">
                Last reviewed by {app.reviewerName}{app.decidedAt ? ` · ${fmtDateNZ(app.decidedAt)}` : ""}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <button
              onClick={onDelete}
              data-testid={`button-delete-application-${app.id}`}
              className="inline-flex items-center gap-1.5 text-[11px] text-white/30 hover:text-red-400"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete application
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
