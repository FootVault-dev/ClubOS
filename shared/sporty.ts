// Sporty / NZ Football NRS — the pure core of the outbound registration push.
// Everything here is side-effect free and runs in server, client AND tests:
// API payload types (from Sporty's Football API v1.1 swagger, fetched
// 2026-07-21), the ClubOS-contact → RegisterPerson mapper with preflight
// validation, the documented-error taxonomy, and reference-data matching.
//
// The grounding rules this module enforces:
//  · Never invent identity data. An unmappable gender, nationality or ethnicity
//    is a BLOCKER surfaced to staff — not a guess. The one allowed inference is
//    a minor using their guardian's email/phone, which is how the paper forms
//    work too.
//  · Validate against Sporty's REAL vocabulary when the reference cache holds
//    it; until then mappings are marked provisional and live pushes tell staff
//    to refresh reference data first.
//  · Dates never round-trip through Date — calendar-part arithmetic only.

import { NZF_ETHNICITIES } from "./academy";

// ── Sporty API types (Football API v1.1) ────────────────────────────────────

export interface SportyAddress {
  StreetAddress?: string;
  Suburb?: string;
  City?: string;
  Region?: string;
  AlphaPostCode?: string;
  Country?: string;
}

export interface SportyRegisterPersonRequest {
  SportyId?: number | null;
  ExternalSystemId?: string;
  FirstName: string;
  FamilyName: string;
  PreferredName?: string;
  /** ISO date, e.g. "2010-03-25" (their swagger says date-time but the documented example is date-only). */
  DateOfBirth: string;
  /** Case-sensitive: "Male" | "Female" | "Non-binary" (verify against GetGenders). */
  Gender: string;
  /** ISO 3166-1 alpha-3. */
  NationalityCode: string;
  /** ISO 3166-1 alpha-3. */
  CountryOfBirthCode: string;
  ParentGuardian1FirstName?: string;
  ParentGuardian1LastName?: string;
  ParentGuardian1Email?: string;
  ParentGuardian1Phone?: string;
  MobilePhone: string;
  Email: string;
  Address: SportyAddress;
  PrimaryEthnicityGroupName: string;
  PrimaryEthnicityGroupSelectionIds?: number[];
  SecondaryEthnicityGroupName?: string;
  SecondaryEthnicityGroupSelectionIds?: number[];
}

export interface SportyRegistrationResponse extends SportyRegisterPersonRequest {
  PersonFifaId?: string;
  SportyId: number;
  DateFrom?: string;
  DateTo?: string;
  Active?: boolean;
}

export interface SportyCountry {
  CountryCode: string;
  CountryName: string;
}

export interface SportyEthnicityGroupSelection {
  EthnicityGroupSelectionId: number;
  EthnicityGroupSelectionName: string;
}

export interface SportyEthnicityGroup {
  EthnicityGroupId: number;
  EthnicityGroupName: string;
  MinimumSelectionsRequired: number;
  MaximumSelectionsRequired: number;
  EthnicityGroupSelections: SportyEthnicityGroupSelection[];
}

export interface SportyReferenceData {
  countries?: SportyCountry[];
  genders?: string[];
  ethnicityGroups?: SportyEthnicityGroup[];
}

// ── Environment namespacing ─────────────────────────────────────────────────
// A SportyId only means something inside the environment that issued it. UAT
// and production are different universes: registration 41822 in UAT is a test
// row, and 41822 in production is somebody's child. Because the SportyId
// doctrine sends any stored id on every later push, a UAT id left in the same
// state row the live push reads would be sent to the real national register.
// So sync state and reference data are namespaced by environment, and the
// PRODUCTION namespace is an explicit allowlist — an unrecognised host gets its
// own namespace rather than being trusted as live.

export type SportyEnvironment = string;

const SPORTY_PROD_HOSTS = ["sporty.co.nz", "www.sporty.co.nz"];

export function sportyEnvironmentFor(baseUrl: string | null | undefined): SportyEnvironment {
  const raw = String(baseUrl || "").trim();
  let host = raw.toLowerCase();
  try {
    host = new URL(raw).host.toLowerCase();
  } catch {
    host = host.replace(/^[a-z]+:\/\//, "").split("/")[0];
  }
  if (!host) return "unknown";
  if (SPORTY_PROD_HOSTS.includes(host)) return "prod";
  if (/(^|\.)uat(\.|-|$)/.test(host)) return "uat";
  // A third environment (a mock, a staging host) gets its own namespace so its
  // ids can never collide with UAT's or production's.
  return host.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "unknown";
}

/** True only for the real national register — used to gate destructive/live copy. */
export function isSportyProduction(baseUrl: string | null | undefined): boolean {
  return sportyEnvironmentFor(baseUrl) === "prod";
}

// ── Sync-state vocabulary (stored in sporty_sync_state, validated app-side) ──

export const SPORTY_SYNC_STATUSES = ["pending", "synced", "blocked", "error", "excluded"] as const;
export type SportySyncStatus = (typeof SPORTY_SYNC_STATUSES)[number];
export function isSportySyncStatus(v: unknown): v is SportySyncStatus {
  return typeof v === "string" && (SPORTY_SYNC_STATUSES as readonly string[]).includes(v);
}

export const SPORTY_BLOCK_REASONS = ["overseas_clearance", "termination_required", "red_flag"] as const;
export type SportyBlockReason = (typeof SPORTY_BLOCK_REASONS)[number];

// ── Documented-error taxonomy ───────────────────────────────────────────────
// Sporty's 400s are business outcomes, not transport failures, and several of
// them mean "the registration EXISTS in Sporty — save the SportyId". The engine
// branches on this classification, so it sticks to the documented message
// shapes and defaults to plain validation when unsure.

export type SportyErrorKind =
  | "already_registered" // registration exists — save SportyId, retry as update
  | "overseas_clearance" // created but inactive; human process at NZF
  | "termination_required" // created but inactive; needs release from another club
  | "red_flag" // player is red-flagged with an organisation
  | "invalid_sporty_id" // our stored SportyId is wrong/inaccessible
  | "validation"; // field-level rejection; nothing created

export function classifySportyError(message: string | null | undefined): SportyErrorKind {
  const m = (message || "").toLowerCase();
  if (m.includes("already registered")) return "already_registered";
  if (m.includes("overseas clearance")) return "overseas_clearance";
  if (m.includes("termination required")) return "termination_required";
  if (m.includes("red flag")) return "red_flag";
  if (m.includes("invalid sportyid") || m.includes("invalid sporty id")) return "invalid_sporty_id";
  return "validation";
}

/** Which block_reason (if any) a Sporty error kind maps to. */
export function blockReasonFor(kind: SportyErrorKind): SportyBlockReason | null {
  if (kind === "overseas_clearance") return "overseas_clearance";
  if (kind === "termination_required") return "termination_required";
  if (kind === "red_flag") return "red_flag";
  return null;
}

// ── Preflight issues ────────────────────────────────────────────────────────

export interface SportyIssue {
  severity: "blocker" | "warning";
  code: string;
  field?: string;
  message: string;
}

// ── Normalisation helpers ───────────────────────────────────────────────────

/** Lowercase, strip diacritics (Māori → maori) and non-alphanumerics — so our
 *  stored vocabulary matches Sporty's regardless of macrons/slashes/spacing. */
export function normalizeName(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ── Gender ──────────────────────────────────────────────────────────────────
// ClubOS genderEnum is male|female|other. Male/Female map cleanly. "other" is
// NOT assumed to mean "Non-binary" — that's identity data we refuse to guess;
// staff resolve it on the contact record (or with Sporty directly).

export function sportyGenderFor(clubosGender: string | null | undefined, ref?: SportyReferenceData): string | null {
  const g = (clubosGender || "").toLowerCase();
  const mapped = g === "male" ? "Male" : g === "female" ? "Female" : null;
  if (!mapped) return null;
  if (ref?.genders?.length && !ref.genders.includes(mapped)) return null;
  return mapped;
}

// ── Country resolution (nationality + country of birth, free text → their code) ─
//
// 🔴 Sporty's country codes are FIFA/IOC-style, NOT the ISO 3166-1 alpha-3 their
// swagger claims. Verified live against UAT 2026-07-27: Samoa=SAM (not WSM),
// Tonga=TGA (not TON), Fiji=FIJ (not FJI), South Africa=RSA (not ZAF),
// Germany=GER (not DEU), Netherlands=NED (not NLD); the home nations exist
// separately (ENG/SCO/WAL) alongside GBR "United Kingdom".
//
// So aliases resolve to a canonical country NAME and the code is read off
// Sporty's own list. Hard-coding codes here is how a player's country of birth
// silently becomes a country their system has never heard of.

const COUNTRY_ALIASES: Record<string, string> = {
  nz: "New Zealand",
  nzl: "New Zealand",
  aotearoa: "New Zealand",
  aotearoanewzealand: "New Zealand",
  newzealandaotearoa: "New Zealand",
  uk: "United Kingdom",
  gb: "United Kingdom",
  greatbritain: "United Kingdom",
  britain: "United Kingdom",
  unitedstates: "USA",
  unitedstatesofamerica: "USA",
  america: "USA",
  us: "USA",
  southkorea: "Korea Republic",
  korea: "Korea Republic",
  northkorea: "Korea DPR",
  holland: "Netherlands",
  thenetherlands: "Netherlands",
  ivorycoast: "Cote d'Ivoire",
  capeverde: "Cabo Verde",
  burma: "Myanmar",
  czechrepublic: "Czechia",
  republicofireland: "Ireland",
  eire: "Ireland",
  uae: "United Arab Emirates",
  drc: "Congo DR",
  westernsamoa: "Samoa",
  png: "Papua New Guinea",
  taiwan: "Chinese Taipei",
  russianfederation: "Russia",

  // Demonyms. Real CUFC data puts "Chinese", "British", "Japanese", "Russian"
  // in the nationality field — a demonym names exactly one country, so this is
  // a fact, not a guess. Values that name TWO ("New Zealand / USA",
  // "French/Japanese") or that are really an ethnicity ("NZ European") are
  // deliberately absent: a human picks those.
  newzealander: "New Zealand",
  kiwi: "New Zealand",
  australian: "Australia",
  british: "United Kingdom",
  english: "England",
  scottish: "Scotland",
  welsh: "Wales",
  irish: "Ireland",
  american: "USA",
  canadian: "Canada",
  chinese: "China",
  japanese: "Japan",
  korean: "Korea Republic",
  indian: "India",
  filipino: "Philippines",
  filipina: "Philippines",
  malaysian: "Malaysia",
  singaporean: "Singapore",
  thai: "Thailand",
  vietnamese: "Vietnam",
  indonesian: "Indonesia",
  srilankan: "Sri Lanka",
  pakistani: "Pakistan",
  bangladeshi: "Bangladesh",
  nepali: "Nepal",
  nepalese: "Nepal",
  afghan: "Afghanistan",
  afghani: "Afghanistan",
  iranian: "Iran",
  iraqi: "Iraq",
  israeli: "Israel",
  turkish: "Turkey",
  egyptian: "Egypt",
  nigerian: "Nigeria",
  kenyan: "Kenya",
  zimbabwean: "Zimbabwe",
  somali: "Somalia",
  ethiopian: "Ethiopia",
  southafrican: "South Africa",
  brazilian: "Brazil",
  argentinian: "Argentina",
  argentine: "Argentina",
  chilean: "Chile",
  colombian: "Colombia",
  mexican: "Mexico",
  uruguayan: "Uruguay",
  german: "Germany",
  french: "France",
  spanish: "Spain",
  portuguese: "Portugal",
  italian: "Italy",
  dutch: "Netherlands",
  croatian: "Croatia",
  serbian: "Serbia",
  russian: "Russia",
  ukrainian: "Ukraine",
  polish: "Poland",
  fijian: "Fiji",
  samoan: "Samoa",
  tongan: "Tonga",
  cookislander: "Cook Islands",
  niuean: "Niue",
  tokelauan: "Tokelau",
  tuvaluan: "Tuvalu",
  nivanuatu: "Vanuatu",
  solomonislander: "Solomon Islands",
  papuanewguinean: "Papua New Guinea",
};

/** Last-resort codes for the preview UI BEFORE reference data has been fetched.
 *  Deliberately tiny and always marked provisional — a live push refreshes the
 *  real list first, so these never decide what reaches the register. */
const PROVISIONAL_CODES: Record<string, string> = {
  newzealand: "NZL",
  australia: "AUS",
  unitedkingdom: "GBR",
  england: "ENG",
  usa: "USA",
};

export interface CountryResolution {
  code: string;
  /** True when resolved without Sporty's country list to confirm it. */
  provisional: boolean;
}

export function resolveCountryCode(
  input: string | null | undefined,
  ref?: SportyReferenceData,
): CountryResolution | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  const countries = ref?.countries;
  const norm = normalizeName(raw);
  const canonical = COUNTRY_ALIASES[norm];

  if (countries?.length) {
    // 1. Already one of THEIR codes?
    if (/^[A-Za-z]{3}$/.test(raw)) {
      const byCode = countries.find((c) => c.CountryCode.toUpperCase() === raw.toUpperCase());
      if (byCode) return { code: byCode.CountryCode.toUpperCase(), provisional: false };
      // A 3-letter string that is not one of their codes may still be an alias
      // ("NZL" where they use something else) — fall through to the name paths.
    }
    // 2. Their own country name.
    const byName = countries.find((c) => normalizeName(c.CountryName) === norm);
    if (byName) return { code: byName.CountryCode.toUpperCase(), provisional: false };
    // 3. Our alias → their canonical name.
    if (canonical) {
      const viaAlias = countries.find((c) => normalizeName(c.CountryName) === normalizeName(canonical));
      if (viaAlias) return { code: viaAlias.CountryCode.toUpperCase(), provisional: false };
    }
    // Refuse rather than invent a code their system will reject or misread.
    return null;
  }

  // No reference data yet (preview only) — provisional, and only for the handful
  // we can vouch for without their list.
  const provisionalKey = canonical ? normalizeName(canonical) : norm;
  const code = PROVISIONAL_CODES[provisionalKey];
  if (code) return { code, provisional: true };
  if (/^[A-Za-z]{3}$/.test(raw) && Object.values(PROVISIONAL_CODES).includes(raw.toUpperCase())) {
    return { code: raw.toUpperCase(), provisional: true };
  }
  return null;
}

// ── Ethnicity resolution ────────────────────────────────────────────────────
// contacts.ethnicity holds one of the six Stats-NZ level-1 groups
// (shared/academy.ts NZF_ETHNICITIES). Sporty's group names are expected to
// match, except MELAA which their own error examples abbreviate. Selections
// (contacts.subEthnicity free text, incl. iwi) are matched against the group's
// selection list when the reference cache holds it.

// Verified against the LIVE UAT vocabulary 2026-07-27. Sporty's seven groups are
// NOT the six Stats-NZ level-1 groups our form collects:
//   NZ European(1) · Māori(2) · Pacific Peoples(3) · Asian(4) · Other(5) · MELAA(6) · Other European(7)
// So "European" matches TWO of their groups and "Other Ethnicity" matches none
// by name — it is their "Other" group, whose selection 294 is literally called
// "Other Ethnicity".
const ETHNICITY_FALLBACK_NAMES: Record<string, string> = {
  European: "European", // deliberately ambiguous → resolved via sub-ethnicity or refused
  "Māori": "Māori",
  "Pacific Peoples": "Pacific Peoples",
  Asian: "Asian",
  "Middle Eastern / Latin American / African": "MELAA",
  "Other Ethnicity": "Other",
};

/** When our group name maps 1:1 to one of their selections, that selection IS
 *  the faithful translation — not a guess. Only exact same-meaning pairs here. */
const ETHNICITY_IMPLIED_SELECTION: Record<string, string> = {
  "Other Ethnicity": "Other Ethnicity", // their group "Other" → selection "Other Ethnicity"
};

/** A sub-ethnicity that names one of their GROUPS outright settles an ambiguous
 *  group ("European" → NZ European vs Other European). These are the person's
 *  own words for their group, not our inference. */
const SUB_NAMES_A_GROUP: Record<string, string> = {
  newzealandeuropean: "NZ European",
  nzeuropean: "NZ European",
  pakeha: "NZ European",
  nzpakeha: "NZ European",
  newzealandpakeha: "NZ European",
  othereuropean: "Other European",
};

/** Exact match first, then containment but ONLY when it is unambiguous.
 *  Substring-first is how "Indian" becomes "Anglo Indian", "Chinese" becomes
 *  "Cambodian Chinese", "Syrian" becomes "Assyrian" and "Ngāti Kahu" becomes
 *  "Ngāpuhi ki Whaingaroa-Ngāti Kahu ki Whaingaroa" — all verified collisions in
 *  their real list. A tie is a human decision, never a coin toss. */
function matchOne<T>(items: T[], nameOf: (t: T) => string, input: string): { hit: T } | { ambiguous: T[] } | null {
  const norm = normalizeName(input);
  if (!norm) return null;
  const exact = items.filter((i) => normalizeName(nameOf(i)) === norm);
  if (exact.length === 1) return { hit: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  if (norm.length < 4) return null; // too short to fuzzy-match safely
  const loose = items.filter((i) => {
    const n = normalizeName(nameOf(i));
    return n.includes(norm) || norm.includes(n);
  });
  if (loose.length === 1) return { hit: loose[0] };
  if (loose.length > 1) return { ambiguous: loose };
  return null;
}

export interface EthnicityResolution {
  groupName: string;
  group?: SportyEthnicityGroup;
  selectionIds: number[];
  /** True when we had no reference data and used the expected name. */
  provisional: boolean;
  /** Set when the group requires selections we couldn't match. */
  selectionShortfall?: { required: number; matched: number; available: string[] };
  /** Our stored name maps to MORE THAN ONE of Sporty's groups (e.g. "European"
   *  → "NZ European" and "Other European"). A human picks; we never do. */
  groupAmbiguity?: { input: string; candidates: string[] };
  /** The sub-ethnicity matched more than one selection (e.g. "Indian" also hits
   *  "Anglo Indian", "Fijian Indian", "Indian Tamil"…). */
  selectionAmbiguity?: { input: string; candidates: string[] };
}

/** Settle a group tie using the sub-ethnicity — the person's own answer.
 *  Returns null when it genuinely cannot be settled, so a human decides. */
function disambiguateGroup(
  candidates: SportyEthnicityGroup[],
  subEthnicity: string | null | undefined,
): SportyEthnicityGroup | null {
  const sub = (subEthnicity || "").trim();
  if (!sub) return null;

  // 1. The sub names one of the groups outright ("New Zealand European").
  const named = SUB_NAMES_A_GROUP[normalizeName(sub)];
  if (named) {
    const hit = candidates.find((g) => normalizeName(g.EthnicityGroupName) === normalizeName(named));
    if (hit) return hit;
  }
  // 2. The sub matches a selection inside exactly ONE of the candidates
  //    ("British" exists only under Other European).
  const owners = candidates.filter((g) => {
    const m = matchOne(g.EthnicityGroupSelections || [], (s) => s.EthnicityGroupSelectionName, sub);
    return !!m && "hit" in m;
  });
  return owners.length === 1 ? owners[0] : null;
}

export function resolveEthnicity(
  ethnicity: string | null | undefined,
  subEthnicity: string | null | undefined,
  ref?: SportyReferenceData,
): EthnicityResolution | null {
  const ours = (ethnicity || "").trim();
  if (!ours || !(NZF_ETHNICITIES as readonly string[]).includes(ours)) return null;
  const fallback = ETHNICITY_FALLBACK_NAMES[ours] ?? ours;

  const groups = ref?.ethnicityGroups;
  if (!groups?.length) {
    return { groupName: fallback, selectionIds: [], provisional: true };
  }

  // Try our stored name, then the expected Sporty name. Exact wins; a tie
  // between two of their groups is reported, never silently broken.
  const byOurs = matchOne(groups, (g) => g.EthnicityGroupName, ours);
  const byFallback = matchOne(groups, (g) => g.EthnicityGroupName, fallback);
  const picked = byOurs && "hit" in byOurs ? byOurs : byFallback && "hit" in byFallback ? byFallback : byOurs ?? byFallback;

  if (!picked) return null;

  let group: SportyEthnicityGroup;
  if ("ambiguous" in picked) {
    // Their vocabulary splits one of our groups in two (European → NZ European /
    // Other European). The family's own sub-ethnicity settles it: either it
    // names one of the groups, or it matches a selection inside exactly one.
    const settled = disambiguateGroup(picked.ambiguous, subEthnicity);
    if (!settled) {
      return {
        groupName: fallback,
        selectionIds: [],
        provisional: false,
        groupAmbiguity: { input: ours, candidates: picked.ambiguous.map((g) => g.EthnicityGroupName) },
      };
    }
    group = settled;
  } else {
    group = picked.hit;
  }

  const selectionIds: number[] = [];
  let selectionAmbiguity: EthnicityResolution["selectionAmbiguity"];
  const sub = (subEthnicity || "").trim() || ETHNICITY_IMPLIED_SELECTION[ours] || "";
  if (sub) {
    const m = matchOne(group.EthnicityGroupSelections || [], (s) => s.EthnicityGroupSelectionName, sub);
    if (m && "hit" in m) selectionIds.push(m.hit.EthnicityGroupSelectionId);
    else if (m && "ambiguous" in m) {
      selectionAmbiguity = { input: sub, candidates: m.ambiguous.map((s) => s.EthnicityGroupSelectionName) };
    }
  }

  const min = group.MinimumSelectionsRequired ?? 0;
  const max = group.MaximumSelectionsRequired ?? 0;
  const capped = max > 0 ? selectionIds.slice(0, max) : selectionIds;
  const result: EthnicityResolution = {
    groupName: group.EthnicityGroupName,
    group,
    selectionIds: capped,
    provisional: false,
    selectionAmbiguity,
  };
  if (min > 0 && capped.length < min) {
    result.selectionShortfall = {
      required: min,
      matched: capped.length,
      available: (group.EthnicityGroupSelections || []).map((s) => s.EthnicityGroupSelectionName),
    };
  }
  return result;
}

// ── Address parsing (contacts.address is ONE free-text field) ───────────────
// Conservative comma-split: street, [suburb…], city, with the last 4-digit
// token as the postcode. Anything we can't confidently place stays in
// StreetAddress and the payload is flagged for the dry-run preview — a human
// eyeballs it, we never fabricate a suburb.
//
// 🔴 Proved against live UAT 2026-07-27: Sporty requires ALL SIX of
// StreetAddress, Suburb, City, Region, AlphaPostCode and Country, and answers
// with a single unhelpful "Address is required." whichever one is missing —
// even though their swagger marks none of them required and shows Region as an
// optional string. So we validate all six ourselves and tell staff exactly
// which part is absent.

export const SPORTY_REQUIRED_ADDRESS_PARTS = [
  ["StreetAddress", "street address"],
  ["Suburb", "suburb"],
  ["City", "city or town"],
  ["Region", "region"],
  ["AlphaPostCode", "postcode"],
  ["Country", "country"],
] as const;

/** Which of Sporty's six mandatory address parts are missing. */
export function missingAddressParts(address: SportyAddress | null | undefined): string[] {
  if (!address) return SPORTY_REQUIRED_ADDRESS_PARTS.map(([, label]) => label);
  return SPORTY_REQUIRED_ADDRESS_PARTS.filter(([key]) => !String((address as any)[key] ?? "").trim()).map(
    ([, label]) => label,
  );
}

// NZ's regions and the cities/districts inside them. A city's region is a
// geographic fact, not a guess — the same class of lookup as "New Zealand" →
// NZL. A city we don't recognise yields NO region, and the player is blocked
// rather than filed under an invented one.
const NZ_CITY_REGION: Record<string, string> = {};
const NZ_REGION_PLACES: Record<string, string[]> = {
  Canterbury: [
    "Christchurch", "Rolleston", "Lincoln", "Rangiora", "Kaiapoi", "Ashburton", "Timaru", "Selwyn",
    "Selwyn District", "Waimakariri", "West Melton", "Prebbleton", "Darfield", "Leeston", "Amberley",
    "Oxford", "Woodend", "Pegasus", "Geraldine", "Temuka", "Methven", "Akaroa", "Lyttelton", "Hawarden",
    "Culverden", "Cheviot", "Waikari", "Springston", "Tai Tapu", "Governors Bay", "Diamond Harbour",
    "Kaikoura", "Kaikōura", "Fairlie", "Twizel", "Pleasant Point", "Waimate", "Rakaia", "Southbridge",
  ],
  Auckland: ["Auckland", "Manukau", "Waitakere", "North Shore", "Papakura", "Pukekohe", "Warkworth", "Helensville"],
  Wellington: ["Wellington", "Lower Hutt", "Upper Hutt", "Porirua", "Kapiti", "Paraparaumu", "Waikanae", "Masterton", "Carterton"],
  Waikato: ["Hamilton", "Cambridge", "Te Awamutu", "Taupo", "Taupō", "Tokoroa", "Thames", "Matamata", "Morrinsville", "Huntly", "Ngaruawahia", "Raglan"],
  "Bay of Plenty": ["Tauranga", "Rotorua", "Whakatane", "Whakatāne", "Mount Maunganui", "Papamoa", "Te Puke", "Kawerau", "Opotiki"],
  Otago: ["Dunedin", "Queenstown", "Wanaka", "Wānaka", "Oamaru", "Alexandra", "Cromwell", "Balclutha", "Mosgiel", "Arrowtown"],
  Southland: ["Invercargill", "Gore", "Te Anau", "Winton", "Bluff", "Riverton"],
  "Hawke's Bay": ["Napier", "Hastings", "Havelock North", "Waipukurau", "Wairoa"],
  Taranaki: ["New Plymouth", "Hawera", "Hāwera", "Stratford", "Inglewood", "Waitara"],
  Manawatu: ["Palmerston North", "Whanganui", "Wanganui", "Levin", "Feilding", "Marton", "Dannevirke", "Foxton"],
  Northland: ["Whangarei", "Whangārei", "Kerikeri", "Kaitaia", "Dargaville", "Paihia", "Kaikohe"],
  Gisborne: ["Gisborne", "Ruatoria"],
  Marlborough: ["Blenheim", "Picton", "Renwick", "Havelock"],
  Nelson: ["Nelson", "Richmond", "Motueka", "Takaka", "Wakefield", "Brightwater"],
  "West Coast": ["Greymouth", "Westport", "Hokitika", "Reefton", "Franz Josef"],
};
for (const [region, places] of Object.entries(NZ_REGION_PLACES)) {
  for (const place of places) NZ_CITY_REGION[normalizeName(place)] = region;
}

/** The NZ region containing a city/town, or null when we don't know it. */
export function nzRegionForCity(city: string | null | undefined): string | null {
  const norm = normalizeName(city || "");
  if (!norm) return null;
  if (NZ_CITY_REGION[norm]) return NZ_CITY_REGION[norm];
  // "Christchurch CBD", "North Addington Christchurch" — a known city inside a
  // longer free-text string still identifies the region unambiguously.
  const hits = new Set<string>();
  for (const [place, region] of Object.entries(NZ_CITY_REGION)) {
    if (place.length >= 5 && norm.includes(place)) hits.add(region);
  }
  return hits.size === 1 ? Array.from(hits)[0] : null;
}

export interface ParsedAddress {
  address: SportyAddress;
  confident: boolean;
}

export function parseNzAddress(raw: string | null | undefined): ParsedAddress | null {
  const text = (raw || "").trim().replace(/\s+/g, " ");
  if (!text) return null;

  let postcode: string | undefined;
  // The LAST standalone 4-digit token is the postcode — EXCEPT one that opens
  // the address, which is a street number. Real example that broke this:
  // "1272 Courtenay Road" was read as postcode 1272 on "Courtenay Road".
  const pcMatches = Array.from(text.matchAll(/(?:^|[\s,])(\d{4})(?=$|[\s,])/g)).filter((m) => m.index !== 0);
  if (pcMatches.length) postcode = pcMatches[pcMatches.length - 1][1];

  let working = postcode
    ? text.replace(new RegExp(`(?:^|[\\s,])${postcode}(?=$|[\\s,])`), " ").replace(/\s+/g, " ").trim()
    : text;
  working = working.replace(/,\s*,/g, ",").replace(/,\s*$/, "").trim();

  let parts = working
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // A trailing "New Zealand" (or NZ) is the country, not the city.
  let country = "New Zealand";
  if (parts.length && ["newzealand", "nz", "aotearoa"].includes(normalizeName(parts[parts.length - 1]))) {
    parts = parts.slice(0, -1);
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) {
    return {
      address: { StreetAddress: parts[0], AlphaPostCode: postcode, Country: country },
      confident: false,
    };
  }

  const street = parts[0];
  const city = parts[parts.length - 1];
  const suburb = parts.slice(1, -1).join(", ") || undefined;
  return {
    address: {
      StreetAddress: street,
      Suburb: suburb,
      City: city,
      Region: nzRegionForCity(city) ?? undefined,
      AlphaPostCode: postcode,
      Country: country,
    },
    confident: true,
  };
}

// ── Minor determination (calendar-part comparison, never Date arithmetic) ────

export function isMinorOn(dobIso: string | null | undefined, todayIso: string): boolean | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec((dobIso || "").trim());
  const tm = /^(\d{4})-(\d{2})-(\d{2})/.exec(todayIso);
  if (!dm || !tm) return null;
  const [dy, dmo, dd] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [ty, tmo, td] = [Number(tm[1]), Number(tm[2]), Number(tm[3])];
  let age = ty - dy;
  if (tmo < dmo || (tmo === dmo && td < dd)) age -= 1;
  return age < 18;
}

/** Date-only ISO string ("2010-03-25") — what we send as DateOfBirth. */
export function dobIsoDateOnly(dob: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((dob || "").trim());
  return m ? m[1] : null;
}

// ── Payload build + preflight validation ────────────────────────────────────

export interface SportyBuildPlayer {
  id: number;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  nationality: string | null;
  countryOfBirth: string | null;
  ethnicity: string | null;
  subEthnicity: string | null;
  ethnicity2: string | null;
  subEthnicity2: string | null;
}

export interface SportyBuildGuardian {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface SportyBuildInput {
  player: SportyBuildPlayer;
  guardian?: SportyBuildGuardian | null;
  sportyId?: number | null;
  ref?: SportyReferenceData;
  todayIso: string;
}

export interface SportyBuildResult {
  payload: SportyRegisterPersonRequest | null;
  issues: SportyIssue[];
  isMinor: boolean | null;
}

export function buildRegisterPerson(input: SportyBuildInput): SportyBuildResult {
  const { player, guardian, ref, todayIso } = input;
  const issues: SportyIssue[] = [];
  const blocker = (code: string, field: string, message: string) =>
    issues.push({ severity: "blocker", code, field, message });
  const warning = (code: string, field: string, message: string) =>
    issues.push({ severity: "warning", code, field, message });

  const firstName = (player.firstName || "").trim();
  const lastName = (player.lastName || "").trim();
  if (!firstName) blocker("missing_first_name", "firstName", "First name is missing.");
  if (!lastName) blocker("missing_last_name", "lastName", "Last name is missing.");

  const dob = dobIsoDateOnly(player.dateOfBirth);
  if (!dob) blocker("missing_dob", "dateOfBirth", "Date of birth is missing or not a valid date.");
  const minor = dob ? isMinorOn(dob, todayIso) : null;

  const gender = sportyGenderFor(player.gender, ref);
  if (!gender) {
    blocker(
      "gender_unmapped",
      "gender",
      player.gender === "other"
        ? 'Gender is recorded as "other" — Sporty accepts Male / Female / Non-binary. Confirm with the family and set it on the contact; we never guess identity data.'
        : "Gender is missing on the contact record.",
    );
  }

  const nationality = resolveCountryCode(player.nationality, ref);
  if (!nationality) {
    blocker(
      "nationality_unresolved",
      "nationality",
      player.nationality
        ? `Nationality "${player.nationality}" couldn't be matched to a country code.`
        : "Nationality is missing — required by NZ Football.",
    );
  } else if (nationality.provisional) {
    warning("nationality_provisional", "nationality", "Nationality mapped without Sporty's country list — refresh reference data to confirm.");
  }

  const birthCountry = resolveCountryCode(player.countryOfBirth, ref);
  if (!birthCountry) {
    blocker(
      "country_of_birth_unresolved",
      "countryOfBirth",
      player.countryOfBirth
        ? `Country of birth "${player.countryOfBirth}" couldn't be matched to a country code.`
        : "Country of birth is missing — required by NZ Football.",
    );
  } else if (birthCountry.provisional) {
    warning("country_of_birth_provisional", "countryOfBirth", "Country of birth mapped without Sporty's country list — refresh reference data to confirm.");
  }

  // A minor's contactable details fall back to the guardian — that's how the
  // paper forms work. An adult must carry their own.
  const email = (player.email || "").trim() || (minor ? (guardian?.email || "").trim() : "");
  if (!email) blocker("missing_email", "email", minor ? "No email on the player or their guardian." : "Email is missing.");
  const phone = (player.phone || "").trim() || (minor ? (guardian?.phone || "").trim() : "");
  if (!phone) blocker("missing_phone", "phone", minor ? "No phone on the player or their guardian." : "Mobile phone is missing.");

  const rawAddress = (player.address || "").trim() || (minor ? (guardian?.address || "").trim() : "");
  const parsedAddress = parseNzAddress(rawAddress);
  if (!parsedAddress) {
    blocker("missing_address", "address", minor ? "No address on the player or their guardian." : "Address is missing.");
  } else {
    // Sporty requires all six parts and will not say which one is absent.
    const missing = missingAddressParts(parsedAddress.address);
    if (missing.length) {
      blocker(
        "address_incomplete",
        "address",
        `NZ Football requires a full address — street, suburb, city, region, postcode and country. "${rawAddress}" is missing: ${missing.join(", ")}.` +
          (missing.includes("region") && parsedAddress.address.City
            ? ` (We derive the region from the city, and "${parsedAddress.address.City}" isn't one we recognise.)`
            : ""),
      );
    } else if (!parsedAddress.confident) {
      warning("address_unstructured", "address", `Address "${rawAddress}" couldn't be split into street/suburb/city — it will be sent as the street line. Check the preview.`);
    }
  }

  const primaryEth = resolveEthnicity(player.ethnicity, player.subEthnicity, ref);
  if (!primaryEth) {
    blocker(
      "ethnicity_unresolved",
      "ethnicity",
      player.ethnicity
        ? `Ethnicity "${player.ethnicity}" couldn't be matched to a Sporty ethnicity group.`
        : "Ethnicity is missing — required by NZ Football.",
    );
  } else {
    if (primaryEth.provisional) {
      warning("ethnicity_provisional", "ethnicity", "Ethnicity group mapped without Sporty's reference list — refresh reference data to confirm.");
    }
    if (primaryEth.groupAmbiguity) {
      const a = primaryEth.groupAmbiguity;
      blocker(
        "ethnicity_group_ambiguous",
        "ethnicity",
        `NZ Football splits "${a.input}" into ${a.candidates.map((c) => `"${c}"`).join(" and ")}. Set the sub-ethnicity on the contact (or pick the group with the family) — we never choose someone's ethnicity for them.`,
      );
    }
    if (primaryEth.selectionAmbiguity) {
      const a = primaryEth.selectionAmbiguity;
      blocker(
        "ethnicity_selection_ambiguous",
        "subEthnicity",
        `"${a.input}" matches ${a.candidates.length} of NZ Football's options (${a.candidates.slice(0, 6).join(", ")}${a.candidates.length > 6 ? "…" : ""}). Choose the exact one on the contact record.`,
      );
    }
    if (primaryEth.selectionShortfall) {
      const s = primaryEth.selectionShortfall;
      blocker(
        "ethnicity_selection_required",
        "subEthnicity",
        `Sporty requires at least ${s.required} specific selection(s) for ${primaryEth.groupName} and "${player.subEthnicity || ""}" matched ${s.matched}. Options include: ${s.available.slice(0, 8).join(", ")}${s.available.length > 8 ? "…" : ""}`,
      );
    }
  }

  let secondaryEth: EthnicityResolution | null = null;
  if ((player.ethnicity2 || "").trim()) {
    secondaryEth = resolveEthnicity(player.ethnicity2, player.subEthnicity2, ref);
    if (!secondaryEth) {
      warning("ethnicity2_unresolved", "ethnicity2", `Second ethnicity "${player.ethnicity2}" couldn't be matched — it will be omitted.`);
    } else if (secondaryEth.groupAmbiguity || secondaryEth.selectionAmbiguity) {
      // A second ethnicity is optional, so an ambiguous one is dropped rather
      // than blocking the whole registration — but never guessed.
      const a = secondaryEth.groupAmbiguity ?? secondaryEth.selectionAmbiguity!;
      warning(
        "ethnicity2_ambiguous",
        "ethnicity2",
        `Second ethnicity "${a.input}" matches more than one NZ Football option (${a.candidates.slice(0, 4).join(", ")}) — it will be omitted rather than guessed.`,
      );
      secondaryEth = null;
    } else if (secondaryEth.selectionShortfall) {
      const s = secondaryEth.selectionShortfall;
      warning(
        "ethnicity2_selection_required",
        "subEthnicity2",
        `Second ethnicity ${secondaryEth.groupName} requires ${s.required} selection(s); matched ${s.matched} — it will be omitted rather than sent incomplete.`,
      );
      secondaryEth = null;
    }
  }

  if (minor === true) {
    const gFirst = (guardian?.firstName || "").trim();
    const gLast = (guardian?.lastName || "").trim();
    const gEmail = (guardian?.email || "").trim();
    const gPhone = (guardian?.phone || "").trim();
    if (!gFirst || !gLast) blocker("missing_guardian_name", "guardian", "Player is under 18 and has no guardian name on record.");
    if (!gEmail) blocker("missing_guardian_email", "guardian", "Player is under 18 and their guardian has no email.");
    if (!gPhone) blocker("missing_guardian_phone", "guardian", "Player is under 18 and their guardian has no phone.");
  }
  if (minor === null && dob) {
    blocker("dob_unparseable", "dateOfBirth", "Could not determine whether the player is a minor from their date of birth.");
  }

  if (issues.some((i) => i.severity === "blocker")) {
    return { payload: null, issues, isMinor: minor };
  }

  const payload: SportyRegisterPersonRequest = {
    ExternalSystemId: `clubos:${player.id}`,
    FirstName: firstName,
    FamilyName: lastName,
    DateOfBirth: dob!,
    Gender: gender!,
    NationalityCode: nationality!.code,
    CountryOfBirthCode: birthCountry!.code,
    MobilePhone: phone,
    Email: email,
    Address: parsedAddress!.address,
    PrimaryEthnicityGroupName: primaryEth!.groupName,
  };
  if (primaryEth!.selectionIds.length) payload.PrimaryEthnicityGroupSelectionIds = primaryEth!.selectionIds;
  if (secondaryEth) {
    payload.SecondaryEthnicityGroupName = secondaryEth.groupName;
    if (secondaryEth.selectionIds.length) payload.SecondaryEthnicityGroupSelectionIds = secondaryEth.selectionIds;
  }
  if (minor === true && guardian) {
    payload.ParentGuardian1FirstName = (guardian.firstName || "").trim();
    payload.ParentGuardian1LastName = (guardian.lastName || "").trim();
    payload.ParentGuardian1Email = (guardian.email || "").trim();
    payload.ParentGuardian1Phone = (guardian.phone || "").trim();
  }
  if (typeof input.sportyId === "number") payload.SportyId = input.sportyId;

  return { payload, issues, isMinor: minor };
}

// ── Payload hashing (skip unchanged re-pushes) ──────────────────────────────
// SportyId is excluded: learning the id after a push must not make the same
// data look "changed". FNV-1a over a key-sorted stringify — stable, dependency
// free, and safe in the client bundle (no node:crypto).

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function sportyPayloadHash(payload: SportyRegisterPersonRequest): string {
  const { SportyId: _omit, ...rest } = payload;
  const str = stableStringify(rest);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}:${str.length}`;
}
