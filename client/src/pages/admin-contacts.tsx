// Contacts — every person the club knows, parents and children alike.
//
// Rebuilt 2026-08-02. The old list took its players from the `children` table
// only, so all 6,506 academy children were missing from it: searching a child
// who had paid online returned nothing, which is what made staff conclude the
// records "aren't linked". Search now runs on the server across BOTH people
// tables, and every row carries its family — whose child this is, or whose
// parent — so the answer is on the row rather than a click away.
import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";
import { Search, Download, Users, X, ChevronRight } from "lucide-react";
import { ageFromDob } from "@shared/family";
import { workspaceFetch } from "@/lib/queryClient";

type Person = {
  key: string;
  kind: "contact" | "child";
  id: number;
  personType: "parent" | "player";
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  parents: string[];
  children: string[];
};

type PeopleData = { people: Person[]; total: number; today: string };

type Filter = "all" | "players" | "parents" | "families";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Everyone" },
  { key: "players", label: "Players" },
  { key: "parents", label: "Parents" },
  { key: "families", label: "Families" },
];

function downloadCSV(rows: Person[], filename: string) {
  if (!rows || rows.length === 0) return;
  const flat = rows.map(p => ({
    Type: p.personType,
    "First name": p.firstName,
    "Last name": p.lastName,
    Email: p.email || "",
    Phone: p.phone || "",
    "Date of birth": p.dateOfBirth || "",
    Parents: p.parents.join("; "),
    Children: p.children.join("; "),
  }));
  const headers = Object.keys(flat[0]);
  const csv = [
    headers.join(","),
    ...flat.map(row => headers.map(h => `"${String((row as any)[h] || "").replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdminContacts() {
  const [, navigate] = useLocation();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  // Debounced so typing a name doesn't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);

  const { data, isLoading, isFetching } = useQuery<PeopleData>({
    queryKey: ["/api/admin/people", query, filter],
    queryFn: async () => {
      // workspaceFetch, not fetch — /api/admin/people is gated by
      // requireTab("contacts"), which 400s without X-Workspace-Slug for anyone
      // who isn't a super admin. A bare fetch here left the whole tab blank for
      // every staff member while looking perfect to Daniel.
      const res = await workspaceFetch(
        `/api/admin/people?q=${encodeURIComponent(query)}&filter=${filter}&limit=100`,
      );
      if (!res.ok) throw new Error("Failed to load people");
      return res.json();
    },
  });

  const people = data?.people || [];

  // ── Collapse duplicate records (Olga, 2026-08-20) ────────────────────────
  // She sent a screenshot of "Darren Zhang · Child of Gong Zhang" repeated
  // SEVEN times and asked "can you check please one child with many profiles".
  // There are 231 such groups and 492 redundant rows: the Friendly Manager
  // import minted a fresh contact per registration, and six of Darren's carry a
  // date of birth one day earlier than the original — the UTC-vs-NZ off-by-one.
  //
  // 🔴 Nothing is merged or deleted here. This is a VIEW: one row per real
  // person, with every record still reachable behind it. Deciding which record
  // survives is a judgement about a real child's history and belongs to a human
  // with the evidence in front of them, not to a list renderer.
  const groups = useMemo(() => {
    const byKey = new Map<string, typeof people>();
    for (const p of people) {
      // Name + DOB. Name alone would fuse two real children who share one, and
      // this list already shows a genuine "Darren Clements" beside the Zhangs.
      const k = [
        p.personType,
        (p.firstName || "").trim().toLowerCase(),
        (p.lastName || "").trim().toLowerCase(),
        p.dateOfBirth || "",
      ].join("|");
      const arr = byKey.get(k); if (arr) arr.push(p); else byKey.set(k, [p]);
    }
    // Preserve the server's ordering: a group sits where its first member was.
    const seen = new Set<string>();
    const out: { lead: (typeof people)[number]; dupes: (typeof people)[number][] }[] = [];
    for (const p of people) {
      const k = [p.personType, (p.firstName || "").trim().toLowerCase(),
                 (p.lastName || "").trim().toLowerCase(), p.dateOfBirth || ""].join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      const all = byKey.get(k)!;
      out.push({ lead: all[0], dupes: all.slice(1) });
    }
    return out;
  }, [people]);

  const [expanded, setExpanded] = useState<string | null>(null);
  const hiddenCount = people.length - groups.length;
  const total = data?.total ?? 0;
  const today = data?.today || new Date().toISOString().slice(0, 10);

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white/90">Contacts</h1>
          <p className="text-[12px] text-white/30 mt-1">
            Players and parents, linked both ways.
          </p>
        </div>
        <button
          onClick={() => downloadCSV(people, `contacts-${today}.csv`)}
          disabled={people.length === 0}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.04] border border-blue-500/[0.08] text-[12px] text-white/60 hover:bg-white/[0.08] transition-colors min-h-[40px] disabled:opacity-40"
          data-testid="button-export-csv"
        >
          <Download className="w-3.5 h-3.5" /> Export
        </button>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-white/20 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Search a child or a parent — name, email or phone"
            className="w-full bg-white/[0.04] border border-blue-500/[0.1] rounded-xl pl-9 pr-9 py-3 text-[13px] text-white/80 placeholder:text-white/20 min-h-[44px]"
            data-testid="input-search-contacts"
          />
          {input && (
            <button
              onClick={() => setInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg hover:bg-white/[0.06] flex items-center justify-center"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5 text-white/30" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-2 rounded-lg text-[12px] transition-colors min-h-[36px] ${
                filter === f.key
                  ? "bg-blue-500/15 border border-blue-500/25 text-blue-200/80"
                  : "bg-white/[0.03] border border-blue-500/[0.06] text-white/40 hover:bg-white/[0.06]"
              }`}
              data-testid={`filter-${f.key}`}
            >
              {f.label}
            </button>
          ))}
          <span className="text-[11px] text-white/25 ml-1">
            {isFetching ? "Searching…" : `${total.toLocaleString()} ${total === 1 ? "person" : "people"}`}
          </span>
        </div>
        {filter === "families" && (
          <p className="text-[11px] text-white/30">
            Parents with more than one child — the sibling view for phone enquiries.
          </p>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl bg-blue-500/[0.04]" />)}
        </div>
      ) : people.length === 0 ? (
        <div className="text-center py-16">
          <Users className="w-8 h-8 text-white/10 mx-auto mb-3" />
          <p className="text-white/30 text-[13px]">
            {query ? `Nobody matching “${query}”.` : "No contacts yet."}
          </p>
          {query && <p className="text-white/20 text-[12px] mt-1">Try fewer letters — the search copes with typos.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {hiddenCount > 0 && (
            <p className="text-[12px] text-foreground/50 pb-1" data-testid="text-collapsed-note">
              {hiddenCount.toLocaleString()} duplicate {hiddenCount === 1 ? "record is" : "records are"} folded into the
              rows below — tap a <span className="text-amber-600">records</span> badge to see them. Nothing has been merged or deleted.
            </p>
          )}
          {groups.map(({ lead: p, dupes }) => {
            const isPlayer = p.personType === "player";
            const age = ageFromDob(p.dateOfBirth, today);
            const fullName = `${p.firstName || ""} ${p.lastName || ""}`.trim();
            const initials = `${p.firstName?.[0] || ""}${p.lastName?.[0] || ""}`.trim();
            return (
              <div key={p.key}>
              <button
                onClick={() => navigate(`/admin/people/${p.key}`)}
                className="w-full text-left px-3 py-3 rounded-xl bg-white/[0.03] border border-blue-500/[0.06] hover:bg-white/[0.07] transition-colors min-h-[44px] flex items-center gap-3"
                data-testid={`row-person-${p.key}`}
              >
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isPlayer ? "bg-emerald-500/10 border border-emerald-500/15" : "bg-amber-500/10 border border-amber-500/15"}`}>
                  <span className={`text-[11px] font-bold ${isPlayer ? "text-emerald-400/70" : "text-amber-400/70"}`}>
                    {initials || "?"}
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* A row is never anonymous — 18 imported contacts carry no
                        name, and a blank row can't be recognised or fixed. */}
                    <span className={`text-[13px] ${fullName ? "text-white/85" : "text-white/35 italic"}`}>
                      {fullName || "No name recorded"}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] uppercase tracking-wider ${isPlayer ? "text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8" : "text-amber-400/70 border-amber-500/20 bg-amber-500/8"}`}
                    >
                      {isPlayer ? "Player" : "Parent"}
                    </Badge>
                    {isPlayer && age !== null && <span className="text-[11px] text-white/25">{age}y</span>}
                    {dupes.length > 0 && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); setExpanded(expanded === p.key ? null : p.key); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setExpanded(expanded === p.key ? null : p.key); } }}
                        className="text-[10px] px-1.5 py-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 cursor-pointer"
                        data-testid={`badge-duplicates-${p.key}`}
                      >
                        {dupes.length + 1} records{expanded === p.key ? " ▲" : " ▼"}
                      </span>
                    )}
                  </div>

                  {/* The family, on the row. A hit on a child's name shows whose
                      child they are without a second click. */}
                  <p className="text-[11px] text-white/35 mt-0.5 truncate">
                    {p.parents.length > 0
                      ? `Child of ${p.parents.join(", ")}`
                      : p.children.length > 0
                        ? `Parent of ${p.children.join(", ")}`
                        : isPlayer
                          ? "No parent linked"
                          : (p.email || p.phone || "No contact details")}
                  </p>
                </div>

                <ChevronRight className="w-4 h-4 text-white/15 flex-shrink-0" />
              </button>

              {/* Every other record for this person, still reachable. Newest
                  first: the most recently created is usually the one the
                  duplicate-minting checkout just made, and the oldest is
                  usually the real one carrying the history. */}
              {expanded === p.key && dupes.length > 0 && (
                <div className="ml-6 mt-1 mb-1 pl-3 border-l-2 border-amber-500/25 space-y-1" data-testid={`dupes-${p.key}`}>
                  <p className="text-[11px] text-foreground/45 py-1">
                    {dupes.length + 1} records for this person. Nothing has been merged — open one to see its history.
                  </p>
                  {[p, ...dupes].map((d, i) => (
                    <button
                      key={d.key}
                      onClick={() => navigate(`/admin/people/${d.key}`)}
                      className="w-full text-left px-3 py-2 rounded-lg bg-white/[0.02] border border-blue-500/[0.06] hover:bg-white/[0.06] transition-colors min-h-[40px] flex items-center gap-2"
                      data-testid={`dupe-row-${d.key}`}
                    >
                      <span className="text-[11.5px] text-foreground/70 min-w-0 truncate">
                        {d.key}
                        {i === 0 && <span className="text-foreground/35"> · shown above</span>}
                      </span>
                      <span className="ml-auto text-[11px] text-foreground/40 whitespace-nowrap">
                        {d.email || d.phone || "no contact details"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              </div>
            );
          })}
          {total > people.length && (
            <p className="text-[11px] text-white/25 text-center py-3">
              Showing the first {people.length.toLocaleString()} of {total.toLocaleString()}. Narrow the search to see more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
