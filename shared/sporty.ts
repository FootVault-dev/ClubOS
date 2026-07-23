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

// ── Country resolution (nationality + country of birth, free text → alpha-3) ─

const COUNTRY_ALIASES: Record<string, string> = {
  newzealand: "NZL",
  nz: "NZL",
  aotearoa: "NZL",
  aotearoanewzealand: "NZL",
  newzealandaotearoa: "NZL",
  australia: "AUS",
  england: "GBR",
  unitedkingdom: "GBR",
  uk: "GBR",
  greatbritain: "GBR",
  scotland: "GBR",
  wales: "GBR",
  northernireland: "GBR",
  ireland: "IRL",
  republicofireland: "IRL",
  unitedstates: "USA",
  unitedstatesofamerica: "USA",
  usa: "USA",
  america: "USA",
  southafrica: "ZAF",
  fiji: "FJI",
  samoa: "WSM",
  tonga: "TON",
  cookislands: "COK",
  papuanewguinea: "PNG",
  india: "IND",
  china: "CHN",
  japan: "JPN",
  southkorea: "KOR",
  korea: "KOR",
  philippines: "PHL",
  brazil: "BRA",
  argentina: "ARG",
  chile: "CHL",
  germany: "DEU",
  france: "FRA",
  spain: "ESP",
  portugal: "PRT",
  italy: "ITA",
  netherlands: "NLD",
  holland: "NLD",
  croatia: "HRV",
  russia: "RUS",
  ukraine: "UKR",
  canada: "CAN",
  mexico: "MEX",
  colombia: "COL",
  uruguay: "URY",
  malaysia: "MYS",
  singapore: "SGP",
  thailand: "THA",
  vietnam: "VNM",
  indonesia: "IDN",
  srilanka: "LKA",
  pakistan: "PAK",
  bangladesh: "BGD",
  nepal: "NPL",
  afghanistan: "AFG",
  iran: "IRN",
  iraq: "IRQ",
  israel: "ISR",
  turkey: "TUR",
  egypt: "EGY",
  nigeria: "NGA",
  kenya: "KEN",
  zimbabwe: "ZWE",
  somalia: "SOM",
  ethiopia: "ETH",
};

export interface CountryResolution {
  code: string;
  /** True when resolved from our alias table without Sporty's country list to confirm. */
  provisional: boolean;
}

export function resolveCountryCode(
  input: string | null | undefined,
  ref?: SportyReferenceData,
): CountryResolution | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  const countries = ref?.countries;

  // Already an alpha-3 code?
  if (/^[A-Za-z]{3}$/.test(raw)) {
    const code = raw.toUpperCase();
    if (countries?.length) {
      return countries.some((c) => c.CountryCode.toUpperCase() === code) ? { code, provisional: false } : null;
    }
    // Without the reference list, only accept codes our alias table can vouch for.
    return Object.values(COUNTRY_ALIASES).includes(code) ? { code, provisional: true } : null;
  }

  const norm = normalizeName(raw);
  if (countries?.length) {
    const hit = countries.find((c) => normalizeName(c.CountryName) === norm);
    if (hit) return { code: hit.CountryCode.toUpperCase(), provisional: false };
  }
  const alias = COUNTRY_ALIASES[norm];
  if (alias) {
    if (countries?.length && !countries.some((c) => c.CountryCode.toUpperCase() === alias)) return null;
    return { code: alias, provisional: !countries?.length };
  }
  return null;
}

// ── Ethnicity resolution ────────────────────────────────────────────────────
// contacts.ethnicity holds one of the six Stats-NZ level-1 groups
// (shared/academy.ts NZF_ETHNICITIES). Sporty's group names are expected to
// match, except MELAA which their own error examples abbreviate. Selections
// (contacts.subEthnicity free text, incl. iwi) are matched against the group's
// selection list when the reference cache holds it.

const ETHNICITY_FALLBACK_NAMES: Record<string, string> = {
  European: "European",
  "Māori": "Māori",
  "Pacific Peoples": "Pacific Peoples",
  Asian: "Asian",
  "Middle Eastern / Latin American / African": "MELAA",
  "Other Ethnicity": "Other Ethnicity",
};

export interface EthnicityResolution {
  groupName: string;
  group?: SportyEthnicityGroup;
  selectionIds: number[];
  /** True when we had no reference data and used the expected name. */
  provisional: boolean;
  /** Set when the group requires selections we couldn't match. */
  selectionShortfall?: { required: number; matched: number; available: string[] };
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

  const oursNorm = normalizeName(ours);
  const fallbackNorm = normalizeName(fallback);
  const group = groups.find((g) => {
    const gn = normalizeName(g.EthnicityGroupName);
    // Exact match on either our Stats-NZ name or the expected Sporty name; a
    // containment check covers styles like "MELAA (Middle Eastern/Latin
    // American/African)" without letting short strings false-match.
    if (gn === oursNorm || gn === fallbackNorm) return true;
    return fallbackNorm.length >= 5 ? gn.includes(fallbackNorm) : gn.startsWith(fallbackNorm);
  });
  if (!group) return null;

  const selectionIds: number[] = [];
  const sub = (subEthnicity || "").trim();
  if (sub) {
    const subNorm = normalizeName(sub);
    for (const s of group.EthnicityGroupSelections || []) {
      const sn = normalizeName(s.EthnicityGroupSelectionName);
      if (sn === subNorm || (subNorm.length >= 4 && (sn.includes(subNorm) || subNorm.includes(sn)))) {
        selectionIds.push(s.EthnicityGroupSelectionId);
        break;
      }
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

export interface ParsedAddress {
  address: SportyAddress;
  confident: boolean;
}

export function parseNzAddress(raw: string | null | undefined): ParsedAddress | null {
  const text = (raw || "").trim().replace(/\s+/g, " ");
  if (!text) return null;

  let postcode: string | undefined;
  // The LAST standalone 4-digit token is the postcode (street numbers come first).
  const pcMatches = Array.from(text.matchAll(/(?:^|[\s,])(\d{4})(?=$|[\s,])/g));
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
  } else if (!parsedAddress.confident) {
    warning("address_unstructured", "address", `Address "${rawAddress}" couldn't be split into street/suburb/city — it will be sent as the street line. Check the preview.`);
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
