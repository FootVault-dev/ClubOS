import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { programDetailPath } from "@/lib/program-path";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useWorkspace } from "@/lib/workspace-context";
import { tabsForOrgSlug, canAccessTab } from "@shared/tabs";
import {
  Search, Send, Building2, Landmark, FileSignature, Crown, ClipboardCheck, UsersRound,
  Trophy, Printer, Inbox, Sparkles, Calendar, MapPin, Tag, Users, User, GraduationCap,
  CornerDownLeft, ArrowUp, ArrowDown, LayoutDashboard,
} from "lucide-react";

// Per-entity presentation + where it lives. `ws` = the workspace slug a record's
// tab is in (used when the record has no org of its own). When the server returns
// an orgSlug, that wins — it's the record's real workspace.
type TypeMeta = { label: string; icon: any; ws: string | null; url: (r: SearchItem) => string };
const TYPE_META: Record<string, TypeMeta> = {
  proposal:         { label: "Proposals",            icon: Send,           ws: "united-sports-group", url: r => `/admin/proposals?open=${r.id}` },
  prospect:         { label: "Sponsorship prospects",icon: Building2,      ws: "united-sports-group", url: () => `/admin/sponsorship` },
  deal:             { label: "Sponsorship deals",    icon: Building2,      ws: "united-sports-group", url: () => `/admin/sponsorship` },
  grant_funder:     { label: "Grant funders",        icon: Landmark,       ws: "united-sports-group", url: () => `/admin/grants` },
  grant_app:        { label: "Grant applications",   icon: Landmark,       ws: "united-sports-group", url: () => `/admin/grants` },
  esign_doc:        { label: "Agreements (e-Sign)",  icon: FileSignature,  ws: null,                  url: () => `/admin/esign` },
  esign_signer:     { label: "e-Sign signers",       icon: FileSignature,  ws: null,                  url: () => `/admin/esign` },
  member:           { label: "Members",              icon: Crown,          ws: "south-island-united", url: () => `/admin/membership` },
  task:             { label: "Tasks",                icon: ClipboardCheck, ws: "united-sports-group", url: () => `/admin/projects` },
  league_team:      { label: "League teams",         icon: UsersRound,     ws: "mini-football-leagues", url: () => `/admin/teams` },
  tournament_team:  { label: "Tournament teams",     icon: Trophy,         ws: "christchurch-international-cup", url: r => r.meta ? `/admin/tournaments/${r.meta}` : `/admin/tournaments` },
  tournament_player:{ label: "Players",              icon: User,           ws: "christchurch-international-cup", url: r => { const [tid, teamId] = (r.meta || "").split(":"); return tid && teamId ? `/admin/tournaments/${tid}/teams/${teamId}` : `/admin/tournaments`; } },
  club:             { label: "Clubs",                icon: Trophy,         ws: "christchurch-international-cup", url: r => `/admin/clubs/${r.id}` },
  print_order:      { label: "Print orders",         icon: Printer,        ws: "united-prints",       url: r => `/admin/print-orders/${r.id}` },
  print_contact:    { label: "Print CRM",            icon: Printer,        ws: "united-prints",       url: () => `/admin/print-crm` },
  inbox:            { label: "Inbox / enquiries",    icon: Inbox,          ws: null,                  url: () => `/admin` },
  cugc_reg:         { label: "Gymnastics registrations", icon: GraduationCap, ws: "united-gymnastics", url: () => `/admin/cugc-registrations` },
  fi_app:           { label: "Football Institute",   icon: GraduationCap,  ws: "christchurch-united", url: () => `/admin/football-institute` },
  community_event:  { label: "Community events",     icon: Calendar,       ws: "south-island-united", url: () => `/admin/events` },
  facility_booking: { label: "Venue bookings",       icon: MapPin,         ws: "united-sports-centre", url: () => `/admin/bookings` },
  program:          { label: "Programs / camps",     icon: Calendar,       ws: null,                  url: r => programDetailPath({ id: Number(r.id), type: r.meta }, r.orgSlug) },
  discount:         { label: "Discounts",            icon: Tag,            ws: null,                  url: r => `/admin/discounts/${r.id}` },
  billboard_deal:   { label: "Billboard deals",      icon: Building2,      ws: "united-sports-group", url: () => `/admin/sponsorship` },
  // Every contact — player or guardian — is a `contacts` row, so the key is
  // always contact-{id}. Routing a player here to /admin/contacts/player/{id}
  // sent a contacts id to an endpoint that reads the `children` table, so
  // clicking an academy child in search returned "Player not found".
  contact:          { label: "Contacts",             icon: Users,          ws: "christchurch-united", url: r => `/admin/people/contact-${r.id}` },
  camp_child:       { label: "Camp children",        icon: Users,          ws: "christchurch-united", url: r => `/admin/people/child-${r.id}` },
  registration:     { label: "Registrations",        icon: ClipboardCheck, ws: "christchurch-united", url: () => `/admin/registrations` },
};

type SearchItem = { type: string; id: string; label: string; sublabel: string | null; meta: string | null; image?: string | null; orgId: number | null; orgSlug: string | null; score: number };
type SearchGroup = { type: string; items: SearchItem[]; best: number };
type NavItem = { title: string; url: string };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const [, setLocation] = useLocation();
  const { currentOrg, organizations, setCurrentOrg } = useWorkspace();
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: me } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });

  // Open on Cmd/Ctrl+K, or when the header search box asks us to.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setOpen(v => !v); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("clubos:open-search", onOpen as EventListener);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("clubos:open-search", onOpen as EventListener); };
  }, []);

  // Reset + focus on open.
  useEffect(() => {
    if (open) { setQuery(""); setDebounced(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 40); }
  }, [open]);

  // Debounce the query.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  const { data: searchData, isFetching } = useQuery<{ groups: SearchGroup[] }>({
    queryKey: ["/api/search", debounced],
    queryFn: async () => {
      const r = await fetch(`/api/search?q=${encodeURIComponent(debounced)}`, { credentials: "include" });
      if (!r.ok) throw new Error("search failed");
      return r.json();
    },
    enabled: open && debounced.length >= 2,
    staleTime: 20_000,
  });

  // Quick-nav: jump to any tab in the current workspace (client-side).
  const navItems: NavItem[] = useMemo(() => {
    if (!currentOrg) return [];
    const q = query.trim().toLowerCase();
    return tabsForOrgSlug(currentOrg.slug)
      .filter(t => canAccessTab({ globalRole: me?.role, membershipRole: currentOrg.userRole, membershipTabs: currentOrg.userTabs, membershipUnlockedTabs: currentOrg.userUnlockedTabs, tabSlug: t.slug }))
      .filter(t => !q || t.title.toLowerCase().includes(q))
      .map(t => ({ title: t.title, url: t.url }));
  }, [currentOrg, me?.role, query]);

  const groups = searchData?.groups || [];

  // Flat list of everything selectable, for arrow-key navigation.
  const flat = useMemo(() => {
    const items: Array<{ kind: "nav"; nav: NavItem } | { kind: "result"; item: SearchItem }> = [];
    for (const n of navItems.slice(0, 6)) items.push({ kind: "nav", nav: n });
    for (const g of groups) for (const it of g.items) items.push({ kind: "result", item: it });
    return items;
  }, [navItems, groups]);

  useEffect(() => { setActive(0); }, [debounced, query]);

  const go = (url: string, orgSlug: string | null) => {
    if (orgSlug && orgSlug !== currentOrg?.slug) {
      const org = organizations.find(o => o.slug === orgSlug);
      if (org) setCurrentOrg(org);
    }
    setOpen(false);
    // Let the workspace switch commit before routing.
    setTimeout(() => setLocation(url), 0);
  };
  const activate = (i: number) => {
    const entry = flat[i];
    if (!entry) return;
    if (entry.kind === "nav") go(entry.nav.url, null);
    else {
      const meta = TYPE_META[entry.item.type];
      if (!meta) return;
      go(meta.url(entry.item), entry.item.orgSlug || meta.ws);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); activate(active); }
  };

  let idx = -1; // running index across sections to match `flat`

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[10%] translate-y-0 max-w-xl p-0 gap-0 overflow-hidden bg-[#0a0e17] border-white/10 shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 px-4 border-b border-white/[0.08]">
          <Search className="w-4 h-4 text-white/30 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search everything — players, sponsors, grants, contracts, proposals…"
            className="flex-1 bg-transparent py-3.5 text-sm text-white/90 placeholder:text-white/30 focus:outline-none"
          />
          {isFetching && <span className="text-[10px] text-white/25">searching…</span>}
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {/* Quick nav */}
          {navItems.length > 0 && (
            <Section title="Go to">
              {navItems.slice(0, 6).map(n => {
                idx++;
                const i = idx;
                return (
                  <Row key={`nav-${n.url}`} active={i === active} onClick={() => activate(i)} onHover={() => setActive(i)}
                    icon={<LayoutDashboard className="w-4 h-4 text-white/40" />} label={n.title} sublabel={n.url} />
                );
              })}
            </Section>
          )}

          {/* Search results */}
          {debounced.length >= 2 && groups.length === 0 && !isFetching && (
            <div className="px-4 py-8 text-center text-sm text-white/35">No matches for “{debounced}”.</div>
          )}
          {groups.map(g => {
            const meta = TYPE_META[g.type];
            const Icon = meta?.icon || Sparkles;
            return (
              <Section key={g.type} title={meta?.label || g.type}>
                {g.items.map(it => {
                  idx++;
                  const i = idx;
                  return (
                    <Row key={`${it.type}-${it.id}`} active={i === active} onClick={() => activate(i)} onHover={() => setActive(i)}
                      icon={<Icon className="w-4 h-4 text-blue-400/70" />} image={it.image} label={it.label} sublabel={it.sublabel}
                      badge={it.orgSlug && it.orgSlug !== currentOrg?.slug ? shortWs(it.orgSlug) : undefined} />
                  );
                })}
              </Section>
            );
          })}

          {debounced.length < 2 && navItems.length > 0 && (
            <div className="px-4 pt-2 pb-1 text-[11px] text-white/25">Type to search across all of ClubOS…</div>
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-white/[0.08] text-[10px] text-white/30">
          <span className="flex items-center gap-1"><ArrowUp className="w-3 h-3" /><ArrowDown className="w-3 h-3" /> navigate</span>
          <span className="flex items-center gap-1"><CornerDownLeft className="w-3 h-3" /> open</span>
          <span className="ml-auto">esc to close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-2 mb-1">
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/25 font-medium">{title}</div>
      {children}
    </div>
  );
}
function Row({ active, onClick, onHover, icon, image, label, sublabel, badge }: {
  active: boolean; onClick: () => void; onHover: () => void; icon: React.ReactNode;
  image?: string | null; label: string; sublabel?: string | null; badge?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!image && !imgFailed;
  return (
    <button
      onClick={onClick}
      onMouseMove={onHover}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${active ? "bg-blue-600/25" : "hover:bg-white/[0.04]"}`}
    >
      <span className="shrink-0">
        {showImg
          ? <img src={image!} alt="" width={20} height={20} loading="lazy" onError={() => setImgFailed(true)}
              className="w-5 h-5 rounded object-cover ring-1 ring-white/10 bg-white/5" />
          : icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-white/90 truncate">{label}</span>
        {sublabel && <span className="block text-[11px] text-white/35 truncate">{sublabel}</span>}
      </span>
      {badge && <span className="shrink-0 text-[9px] font-semibold text-white/40 border border-white/10 rounded px-1.5 py-0.5">{badge}</span>}
    </button>
  );
}

function shortWs(slug: string): string {
  const map: Record<string, string> = {
    "christchurch-united": "CUFC", "south-island-united": "SIU", "mini-football-leagues": "MFL",
    "christchurch-international-cup": "CIC", "united-gymnastics": "CUGC", "united-sports-centre": "USC",
    "united-sports-group": "USG", "united-prints": "Print",
  };
  return map[slug] || slug;
}
