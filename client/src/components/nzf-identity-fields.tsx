// NZ Football identity fields — country, ethnicity and address, offered as the
// values NZ Football actually accepts.
//
// These replaced free-text boxes on 28 July 2026. The free-text versions looked
// fine and quietly produced unregisterable data: a country of birth of
// "Christchurch", another of "ニュージーランド", nationalities holding two values,
// and 68 bare "European" answers — a group NZ Football does not have, because
// their taxonomy splits NZ European from Other European. Sporty refused a
// 495-person import on exactly these fields.
//
// Design rules:
//   · The parent picks from NZF's list, so their answer is valid immediately.
//   · Never pre-select. A defaulted ethnicity or nationality is a fact invented
//     about a child. Empty is honest; the validator asks for it.
//   · Each group's own min/max drives the specific-ethnicity control, so the
//     form asks for exactly what NZF requires and no more (NZ European asks for
//     nothing, Māori takes up to four iwi, the rest take one or two).
//   · Everything is typeable. 247 countries in a native <select> is unusable on
//     a phone.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

export interface NzfCountryOption { code: string; name: string }
export interface NzfSelectionOption { id: number; name: string }
export interface NzfGroupOption {
  id: number;
  name: string;
  minSelections: number;
  maxSelections: number;
  selections: NzfSelectionOption[];
}

export interface NzfIdentityValue {
  countryOfBirthCode: string;
  nationalityCode: string;
  ethnicityGroupId: number | null;
  ethnicitySelectionIds: number[];
  ethnicity2GroupId: number | null;
  ethnicity2SelectionIds: number[];
}

export interface NzfAddressValue {
  street: string;
  suburb: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
}

export const EMPTY_NZF_IDENTITY: NzfIdentityValue = {
  countryOfBirthCode: "",
  nationalityCode: "",
  ethnicityGroupId: null,
  ethnicitySelectionIds: [],
  ethnicity2GroupId: null,
  ethnicity2SelectionIds: [],
};

// Country is NOT defaulted to NZL even though most families are here — see the
// header. Everything else empty for the same reason.
export const EMPTY_NZF_ADDRESS: NzfAddressValue = {
  street: "", suburb: "", city: "", region: "", postcode: "", country: "",
};

interface Theme {
  gold: string;
  goldBright: string;
  line: string;
  mute: string;
  fieldCls: string;
  fieldStyle: React.CSSProperties;
  /** The host form's own label styling. Passed in rather than hardcoded so
   *  these controls sit inside the public form and the admin console without
   *  either one looking like a bolt-on. */
  labelCls: string;
  labelStyle?: React.CSSProperties;
}

function FieldLabel({ theme, children, required }: { theme: Theme; children: React.ReactNode; required?: boolean }) {
  return (
    <label className={theme.labelCls} style={theme.labelStyle}>
      {children}
      {required && <span style={{ color: theme.gold }}> *</span>}
    </label>
  );
}

// ── Searchable picker ───────────────────────────────────────────────────────

/** Where the dropdown panel should open, and how tall it may be.
 *
 *  A phone caught this: a picker near the bottom of the form opened downward
 *  and its list ran straight off the screen, so a parent could see two options
 *  out of forty. The panel now flips above the field when there isn't room
 *  below, and its height is capped to the space that actually exists. */
function usePanelPlacement(open: boolean, triggerRef: React.RefObject<HTMLElement | null>) {
  const [placement, setPlacement] = useState<{ above: boolean; maxHeight: number }>({
    above: false,
    maxHeight: 260,
  });

  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const GAP = 12;               // breathing room from the viewport edge
      const MIN_USABLE = 180;       // below this a list is not worth showing
      const below = window.innerHeight - r.bottom - GAP;
      const above = r.top - GAP;
      // Prefer downward — it matches where the finger already is — and only
      // flip when down is genuinely too small AND up is better.
      const flip = below < MIN_USABLE && above > below;
      setPlacement({ above: flip, maxHeight: Math.max(140, Math.min(320, flip ? above : below)) });
    };
    measure();
    window.addEventListener("resize", measure);
    // Capture phase: catch scrolling inside the form's own scroll container too.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, triggerRef]);

  return placement;
}

function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

export function CountryPicker({
  value, onChange, countries, theme, testId, placeholder = "Search countries…",
}: {
  value: string;
  onChange: (code: string) => void;
  countries: NzfCountryOption[];
  theme: Theme;
  testId?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useOutsideClose(open, () => { setOpen(false); setQ(""); });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const placement = usePanelPlacement(open, triggerRef);
  const selected = countries.find((c) => c.code === value) ?? null;

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      // No search yet: surface the countries our families actually pick most,
      // then everything. Convenience only — nothing is pre-selected.
      const common = ["NZL", "AUS", "GBR", "RSA", "IND", "CHN", "PHI", "FIJ", "SAM", "TGA", "USA", "BRA"];
      const head = common.map((c) => countries.find((x) => x.code === c)).filter(Boolean) as NzfCountryOption[];
      const rest = countries.filter((c) => !common.includes(c.code));
      return [...head, ...rest];
    }
    const starts = countries.filter((c) => c.name.toLowerCase().startsWith(needle));
    const contains = countries.filter(
      (c) => !c.name.toLowerCase().startsWith(needle) &&
        (c.name.toLowerCase().includes(needle) || c.code.toLowerCase() === needle),
    );
    return [...starts, ...contains];
  }, [q, countries]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid={testId}
        className={`${theme.fieldCls} flex items-center justify-between text-left`}
        style={theme.fieldStyle}
      >
        <span style={{ color: selected ? undefined : theme.mute }}>
          {selected ? selected.name : "Select…"}
        </span>
        <ChevronDown className="w-4 h-4 flex-shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          className={`absolute z-50 w-full rounded-xl overflow-hidden shadow-2xl ${placement.above ? "bottom-full mb-1" : "top-full mt-1"}`}
          style={{ background: "hsl(var(--card))", border: `1px solid ${theme.line}` }}
        >
          <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${theme.line}` }}>
            <Search className="w-4 h-4 opacity-50 flex-shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={placeholder}
              className="w-full bg-transparent outline-none text-[15px] py-1"
              style={{ color: "hsl(var(--foreground))" }}
              data-testid={testId ? `${testId}-search` : undefined}
            />
            {q && (
              <button type="button" onClick={() => setQ("")} aria-label="Clear">
                <X className="w-4 h-4 opacity-50" />
              </button>
            )}
          </div>
          <div className="overflow-y-auto overscroll-contain" style={{ maxHeight: placement.maxHeight }}>
            {matches.length === 0 ? (
              <div className="px-3 py-4 text-[13px]" style={{ color: theme.mute }}>
                No country matches "{q}".
              </div>
            ) : (
              matches.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => { onChange(c.code); setOpen(false); setQ(""); }}
                  className="w-full text-left px-3 py-2.5 text-[15px] flex items-center justify-between hover:bg-white/5"
                  style={{ color: c.code === value ? theme.goldBright : "hsl(var(--foreground))" }}
                >
                  <span>{c.name}</span>
                  {c.code === value && <Check className="w-4 h-4" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Specific ethnicities (multi-select honouring the group's own min/max) ────

function SelectionPicker({
  group, value, onChange, theme, testId,
}: {
  group: NzfGroupOption;
  value: number[];
  onChange: (ids: number[]) => void;
  theme: Theme;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useOutsideClose(open, () => { setOpen(false); setQ(""); });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const placement = usePanelPlacement(open, triggerRef);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return group.selections;
    return group.selections.filter((s) => s.name.toLowerCase().includes(needle));
  }, [q, group.selections]);

  const chosen = group.selections.filter((s) => value.includes(s.id));
  const atMax = value.length >= group.maxSelections;

  const toggle = (id: number) => {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else if (!atMax) onChange([...value, id]);
    // At the cap, tapping an unchosen option does nothing rather than silently
    // evicting an earlier answer the family deliberately made.
  };

  const label =
    group.minSelections > 0
      ? `Specific ethnicity${group.maxSelections > 1 ? ` (choose ${group.minSelections === group.maxSelections ? group.minSelections : `${group.minSelections}–${group.maxSelections}`})` : ""}`
      : `Iwi (optional, up to ${group.maxSelections})`;

  return (
    <div>
      <FieldLabel theme={theme} required={group.minSelections > 0}>{label}</FieldLabel>

      <div className="relative" ref={ref}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          data-testid={testId}
          className={`${theme.fieldCls} flex items-center justify-between text-left`}
          style={theme.fieldStyle}
        >
          <span style={{ color: chosen.length ? undefined : theme.mute }}>
            {chosen.length ? chosen.map((c) => c.name).join(", ") : "Select…"}
          </span>
          <ChevronDown className="w-4 h-4 flex-shrink-0 opacity-60" />
        </button>

        {open && (
          <div
            className={`absolute z-50 w-full rounded-xl overflow-hidden shadow-2xl ${placement.above ? "bottom-full mb-1" : "top-full mt-1"}`}
            style={{ background: "hsl(var(--card))", border: `1px solid ${theme.line}` }}
          >
            {group.selections.length > 8 && (
              <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${theme.line}` }}>
                <Search className="w-4 h-4 opacity-50 flex-shrink-0" />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search…"
                  className="w-full bg-transparent outline-none text-[15px] py-1"
                  style={{ color: "hsl(var(--foreground))" }}
                />
              </div>
            )}
            <div className="overflow-y-auto overscroll-contain" style={{ maxHeight: placement.maxHeight }}>
              {matches.map((s) => {
                const on = value.includes(s.id);
                const disabled = !on && atMax;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggle(s.id)}
                    disabled={disabled}
                    className="w-full text-left px-3 py-2.5 text-[15px] flex items-center justify-between hover:bg-white/5 disabled:opacity-35"
                    style={{ color: on ? theme.goldBright : "hsl(var(--foreground))" }}
                  >
                    <span>{s.name}</span>
                    {on && <Check className="w-4 h-4" />}
                  </button>
                );
              })}
            </div>
            {atMax && (
              <div className="px-3 py-2 text-[12px]" style={{ color: theme.mute, borderTop: `1px solid ${theme.line}` }}>
                That's the maximum NZ Football allows. Remove one to choose another.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Ethnicity block ─────────────────────────────────────────────────────────

function EthnicityBlock({
  groups, groupId, selectionIds, onChange, theme, idPrefix, optional,
}: {
  groups: NzfGroupOption[];
  groupId: number | null;
  selectionIds: number[];
  onChange: (groupId: number | null, selectionIds: number[]) => void;
  theme: Theme;
  idPrefix: string;
  optional?: boolean;
}) {
  const group = groups.find((g) => g.id === groupId) ?? null;
  return (
    <div className="space-y-4">
      <div>
        <FieldLabel theme={theme} required={!optional}>
          {optional ? "Second ethnic group (optional)" : "Ethnic group"}
        </FieldLabel>
        <select
          value={groupId ?? ""}
          // Changing group always clears the selections: an id from the old
          // group is meaningless under the new one, and carrying it over would
          // file the child under an ethnicity nobody chose.
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null, [])}
          className={theme.fieldCls}
          style={theme.fieldStyle}
          data-testid={`select-${idPrefix}-ethnic-group`}
        >
          <option value="">Select…</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      {/* NZ European takes no specific ethnicity at all — asking for one would
          invent a question NZ Football doesn't ask. */}
      {group && group.maxSelections > 0 && (
        <SelectionPicker
          group={group}
          value={selectionIds}
          onChange={(ids) => onChange(groupId, ids)}
          theme={theme}
          testId={`select-${idPrefix}-specific-ethnicity`}
        />
      )}
    </div>
  );
}

export function NzfIdentityFields({
  value, onChange, countries, groups, theme,
}: {
  value: NzfIdentityValue;
  onChange: (v: NzfIdentityValue) => void;
  countries: NzfCountryOption[];
  groups: NzfGroupOption[];
  theme: Theme;
}) {
  const [showSecond, setShowSecond] = useState(value.ethnicity2GroupId != null);
  const set = (patch: Partial<NzfIdentityValue>) => onChange({ ...value, ...patch });

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <FieldLabel theme={theme} required>Country of birth</FieldLabel>
          <CountryPicker
            value={value.countryOfBirthCode}
            onChange={(code) => set({ countryOfBirthCode: code })}
            countries={countries}
            theme={theme}
            testId="select-child-country-of-birth"
          />
        </div>
        <div>
          <FieldLabel theme={theme} required>Nationality</FieldLabel>
          <CountryPicker
            value={value.nationalityCode}
            onChange={(code) => set({ nationalityCode: code })}
            countries={countries}
            theme={theme}
            testId="select-child-nationality"
          />
        </div>
      </div>

      <div className="rounded-xl p-4 space-y-4" style={{ background: "hsl(var(--muted) / 0.4)", border: `1px solid ${theme.line}` }}>
        <div className="text-[12px]" style={{ color: theme.mute }}>
          New Zealand Football asks every registered player for this. These are their categories.
        </div>

        <EthnicityBlock
          groups={groups}
          groupId={value.ethnicityGroupId}
          selectionIds={value.ethnicitySelectionIds}
          onChange={(g, ids) => set({ ethnicityGroupId: g, ethnicitySelectionIds: ids })}
          theme={theme}
          idPrefix="child"
        />

        {!showSecond ? (
          <button
            type="button"
            onClick={() => setShowSecond(true)}
            className="text-[13px] font-semibold underline"
            style={{ color: theme.goldBright }}
            data-testid="button-add-second-ethnicity"
          >
            + Add a second ethnicity
          </button>
        ) : (
          <div className="pt-4 space-y-4" style={{ borderTop: `1px solid ${theme.line}` }}>
            <EthnicityBlock
              groups={groups.filter((g) => g.id !== value.ethnicityGroupId)}
              groupId={value.ethnicity2GroupId}
              selectionIds={value.ethnicity2SelectionIds}
              onChange={(g, ids) => set({ ethnicity2GroupId: g, ethnicity2SelectionIds: ids })}
              theme={theme}
              idPrefix="child-2"
              optional
            />
            <button
              type="button"
              onClick={() => { setShowSecond(false); set({ ethnicity2GroupId: null, ethnicity2SelectionIds: [] }); }}
              className="text-[13px] underline"
              style={{ color: theme.mute }}
            >
              Remove second ethnicity
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ── Address ─────────────────────────────────────────────────────────────────

export function NzfAddressFields({
  value, onChange, countries, regions, theme,
}: {
  value: NzfAddressValue;
  onChange: (v: NzfAddressValue) => void;
  countries: NzfCountryOption[];
  regions: readonly string[];
  theme: Theme;
}) {
  const set = (patch: Partial<NzfAddressValue>) => onChange({ ...value, ...patch });
  const isNz = value.country === "NZL";

  const label = (text: string) => <FieldLabel theme={theme} required>{text}</FieldLabel>;

  return (
    <div className="space-y-4">
      <div className="text-[12px]" style={{ color: theme.mute }}>
        New Zealand Football needs the full address — every part, including the region.
      </div>

      <div>
        {label("Street address")}
        <input
          value={value.street}
          onChange={(e) => set({ street: e.target.value })}
          placeholder="123 Example Street"
          autoComplete="address-line1"
          className={theme.fieldCls}
          style={theme.fieldStyle}
          data-testid="input-address-street"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          {label("Suburb")}
          <input
            value={value.suburb}
            onChange={(e) => set({ suburb: e.target.value })}
            autoComplete="address-level3"
            className={theme.fieldCls}
            style={theme.fieldStyle}
            data-testid="input-address-suburb"
          />
        </div>
        <div>
          {label("City or town")}
          <input
            value={value.city}
            onChange={(e) => set({ city: e.target.value })}
            autoComplete="address-level2"
            className={theme.fieldCls}
            style={theme.fieldStyle}
            data-testid="input-address-city"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          {label("Region")}
          {/* A list for NZ (NZF validates against their own regions), free text
              for anywhere else — an overseas family's region isn't ours to
              enumerate. */}
          {isNz ? (
            <select
              value={value.region}
              onChange={(e) => set({ region: e.target.value })}
              className={theme.fieldCls}
              style={theme.fieldStyle}
              data-testid="select-address-region"
            >
              <option value="">Select…</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          ) : (
            <input
              value={value.region}
              onChange={(e) => set({ region: e.target.value })}
              placeholder={value.country ? "State / province / region" : "Choose a country first"}
              disabled={!value.country}
              className={theme.fieldCls}
              style={theme.fieldStyle}
              data-testid="input-address-region"
            />
          )}
        </div>
        <div>
          {label("Postcode")}
          <input
            value={value.postcode}
            onChange={(e) => set({ postcode: e.target.value })}
            inputMode="numeric"
            autoComplete="postal-code"
            className={theme.fieldCls}
            style={theme.fieldStyle}
            data-testid="input-address-postcode"
          />
        </div>
      </div>

      <div>
        {label("Country")}
        <CountryPicker
          value={value.country}
          // Switching between NZ and overseas swaps the region control between a
          // list and free text, so a region chosen under the old country is
          // cleared rather than left stranded in the wrong vocabulary.
          onChange={(code) => set({ country: code, region: code === value.country ? value.region : "" })}
          countries={countries}
          theme={theme}
          testId="select-address-country"
        />
      </div>
    </div>
  );
}
