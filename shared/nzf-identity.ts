// NZ Football identity fields — the vocabulary, and what a valid answer is.
//
// The point of this module: a parent picks from NZ Football's OWN published
// lists, so their answer is already valid at the moment they give it. There is
// no mapping step left to guess wrong later.
//
// Background. Until 28 July 2026 ClubOS asked for country of birth, nationality
// and ethnicity as free text. What came back could not be registered: a country
// of birth of "Christchurch", another of "ニュージーランド", nationalities holding
// two values or an ethnicity, and 68 bare "European" answers — a group NZ
// Football does not have, because their taxonomy splits NZ European from Other
// European. Sporty refused a 495-person import on exactly these fields, and our
// own UAT run passed only 8 of 116. Both failures had the same upstream cause.
//
// 🔴 Rules that hold everywhere in this file:
//   · Never infer a person's ethnicity, nationality or country of birth. An
//     unanswerable question stays unanswered; a guess becomes a fact about a
//     child the moment it is stored.
//   · Country codes are FIFA/IOC, not ISO 3166-1 alpha-3 (Samoa SAM, Germany
//     GER, Netherlands NED). Always read a code off NZF_COUNTRIES.
//   · Match exactly. Substring matching silently registered real people as the
//     wrong ethnicity ("Indian" → "Anglo Indian", "Chinese" → "Cambodian
//     Chinese", "Russian" → "Belorussian").

import {
  NZF_COUNTRIES,
  NZF_ETHNICITY_GROUPS,
  NZF_GENDERS,
  type NzfCountry,
  type NzfEthnicityGroup,
} from "./nzf-vocabulary";

export { NZF_COUNTRIES, NZF_ETHNICITY_GROUPS, NZF_GENDERS };
export type { NzfCountry, NzfEthnicityGroup };

// ── NZ regions ──────────────────────────────────────────────────────────────
// Sporty requires Region and rejects the whole address without it, despite its
// swagger marking it optional. Offered as a list rather than derived from the
// city, because deriving it is a guess that renders as a fact on a registration.
export const NZ_REGIONS = [
  "Northland",
  "Auckland",
  "Waikato",
  "Bay of Plenty",
  "Gisborne",
  "Hawke's Bay",
  "Taranaki",
  "Manawatu",
  "Wellington",
  "Nelson",
  "Marlborough",
  "West Coast",
  "Canterbury",
  "Otago",
  "Southland",
] as const;
export type NzRegion = (typeof NZ_REGIONS)[number];

// ── Lookups ─────────────────────────────────────────────────────────────────

const COUNTRY_BY_CODE = new Map(NZF_COUNTRIES.map((c) => [c.code.toUpperCase(), c]));
const COUNTRY_BY_NAME = new Map(NZF_COUNTRIES.map((c) => [c.name.trim().toLowerCase(), c]));
const GROUP_BY_ID = new Map(NZF_ETHNICITY_GROUPS.map((g) => [g.id, g]));

export function countryByCode(code: string | null | undefined): NzfCountry | null {
  const k = (code || "").trim().toUpperCase();
  return k ? COUNTRY_BY_CODE.get(k) ?? null : null;
}

/** Exact name match only. A near-miss returns null rather than a best guess. */
export function countryByName(name: string | null | undefined): NzfCountry | null {
  const k = (name || "").trim().toLowerCase();
  return k ? COUNTRY_BY_NAME.get(k) ?? null : null;
}

export function ethnicityGroupById(id: number | null | undefined): NzfEthnicityGroup | null {
  return typeof id === "number" ? GROUP_BY_ID.get(id) ?? null : null;
}

export function selectionsFor(groupId: number | null | undefined) {
  return ethnicityGroupById(groupId)?.selections ?? [];
}

/** True when the group takes no specific selections at all (NZ European). */
export function groupTakesNoSelections(groupId: number | null | undefined): boolean {
  const g = ethnicityGroupById(groupId);
  return !!g && g.maxSelections === 0;
}

// ── The structured answer ───────────────────────────────────────────────────

export interface NzfIdentityInput {
  countryOfBirthCode?: unknown;
  nationalityCode?: unknown;
  ethnicityGroupId?: unknown;
  ethnicitySelectionIds?: unknown;
  ethnicity2GroupId?: unknown;
  ethnicity2SelectionIds?: unknown;
}

export interface NzfAddressInput {
  street?: unknown;
  suburb?: unknown;
  city?: unknown;
  region?: unknown;
  postcode?: unknown;
  country?: unknown;
}

/** What we store: codes and ids, plus the display names resolved from them so
 *  every existing read path (exports, the Sporty mapper, admin screens) keeps
 *  seeing a human-readable value without re-deriving it. */
export interface ResolvedNzfIdentity {
  countryOfBirth: string;
  countryOfBirthCode: string;
  nationality: string;
  nationalityCode: string;
  ethnicity: string;
  ethnicityGroupId: number;
  ethnicitySelectionIds: number[];
  subEthnicity: string | null;
  ethnicity2: string | null;
  ethnicity2GroupId: number | null;
  ethnicity2SelectionIds: number[];
  subEthnicity2: string | null;
}

function intList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const raw of v) {
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    if (Number.isInteger(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

function asInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isInteger(n) ? n : null;
}

/** Validate one ethnicity choice against its group's own rules.
 *  Returns the selection NAMES, or an error string. */
function checkEthnicity(
  groupId: number,
  selectionIds: number[],
  label: string,
): { ok: true; group: NzfEthnicityGroup; names: string[] } | { ok: false; error: string } {
  const group = ethnicityGroupById(groupId);
  if (!group) return { ok: false, error: `${label} is not a recognised New Zealand Football ethnic group.` };

  // NZ European takes no selections. Sending one is not a harmless extra — it
  // is a value the group has no vocabulary for.
  if (group.maxSelections === 0) {
    if (selectionIds.length > 0) {
      return { ok: false, error: `${group.name} does not take a specific ethnicity.` };
    }
    return { ok: true, group, names: [] };
  }

  const valid = new Map(group.selections.map((s) => [s.id, s.name]));
  const unknown = selectionIds.filter((id) => !valid.has(id));
  if (unknown.length) {
    return { ok: false, error: `${label}: one or more specific ethnicities are not options under ${group.name}.` };
  }
  if (selectionIds.length < group.minSelections) {
    const n = group.minSelections;
    return {
      ok: false,
      error: `${group.name} needs ${n === 1 ? "a specific ethnicity" : `at least ${n} specific ethnicities`} — please choose from the list.`,
    };
  }
  if (selectionIds.length > group.maxSelections) {
    return { ok: false, error: `${group.name} allows at most ${group.maxSelections}.` };
  }
  return { ok: true, group, names: selectionIds.map((id) => valid.get(id)!) };
}

/** Validate a whole identity answer. Errors are worded for a parent reading
 *  them on a phone, not for a developer reading a log. */
export function validateNzfIdentity(
  input: NzfIdentityInput,
): { ok: true; value: ResolvedNzfIdentity } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const cob = countryByCode(input.countryOfBirthCode as string);
  if (!cob) errors.push("Please choose the player's country of birth from the list.");

  const nat = countryByCode(input.nationalityCode as string);
  if (!nat) errors.push("Please choose the player's nationality from the list.");

  const groupId = asInt(input.ethnicityGroupId);
  const selIds = intList(input.ethnicitySelectionIds);
  let primary: { group: NzfEthnicityGroup; names: string[] } | null = null;
  if (groupId === null) {
    errors.push("Please choose the player's ethnic group.");
  } else {
    const r = checkEthnicity(groupId, selIds, "Ethnic group");
    if (r.ok) primary = { group: r.group, names: r.names };
    else errors.push(r.error);
  }

  // Second ethnicity is optional. Given one, it must be as valid as the first —
  // and must not simply repeat the first, which tells NZF nothing.
  const group2Id = asInt(input.ethnicity2GroupId);
  const sel2Ids = intList(input.ethnicity2SelectionIds);
  let secondary: { group: NzfEthnicityGroup; names: string[] } | null = null;
  if (group2Id !== null) {
    if (group2Id === groupId) {
      errors.push("The second ethnic group is the same as the first — remove it or choose a different one.");
    } else {
      const r = checkEthnicity(group2Id, sel2Ids, "Second ethnic group");
      if (r.ok) secondary = { group: r.group, names: r.names };
      else errors.push(r.error);
    }
  } else if (sel2Ids.length) {
    errors.push("A specific second ethnicity was given without an ethnic group.");
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      countryOfBirth: cob!.name,
      countryOfBirthCode: cob!.code,
      nationality: nat!.name,
      nationalityCode: nat!.code,
      ethnicity: primary!.group.name,
      ethnicityGroupId: primary!.group.id,
      ethnicitySelectionIds: selIds,
      subEthnicity: primary!.names.length ? primary!.names.join(", ") : null,
      ethnicity2: secondary?.group.name ?? null,
      ethnicity2GroupId: secondary?.group.id ?? null,
      ethnicity2SelectionIds: secondary ? sel2Ids : [],
      subEthnicity2: secondary?.names.length ? secondary.names.join(", ") : null,
    },
  };
}

export interface ResolvedNzfAddress {
  street: string;
  suburb: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
  countryCode: string;
  /** The one-line form, for the legacy `contacts.address` column so every
   *  existing screen and export keeps rendering something sensible. */
  oneLine: string;
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** All six parts are required because Sporty rejects the address otherwise —
 *  and it returns the same "Address is required." whichever part is missing,
 *  so a partial address is not a partial success, it is a failed registration. */
export function validateNzfAddress(
  input: NzfAddressInput,
): { ok: true; value: ResolvedNzfAddress } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const street = s(input.street);
  const suburb = s(input.suburb);
  const city = s(input.city);
  const region = s(input.region);
  const postcode = s(input.postcode);
  const country = countryByCode(input.country as string);

  if (!street) errors.push("Street address is required.");
  if (!suburb) errors.push("Suburb is required.");
  if (!city) errors.push("City or town is required.");
  if (!region) errors.push("Region is required by New Zealand Football.");
  else if (country?.code === "NZL" && !(NZ_REGIONS as readonly string[]).includes(region)) {
    errors.push("Please choose a region from the list.");
  }
  if (!postcode) errors.push("Postcode is required.");
  if (!country) errors.push("Please choose a country from the list.");

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      street,
      suburb,
      city,
      region,
      postcode,
      country: country!.name,
      countryCode: country!.code,
      oneLine: [street, suburb, city, postcode, country!.code === "NZL" ? "" : country!.name]
        .filter(Boolean)
        .join(", "),
    },
  };
}

// ── Reading the gap ─────────────────────────────────────────────────────────

export interface IdentityGap {
  countryOfBirth: boolean;
  nationality: boolean;
  ethnicity: boolean;
  address: boolean;
}

/** What's still missing on an existing contact — drives the backfill campaign
 *  and the admin "incomplete for NZF" view. Reads the STRUCTURED columns: a
 *  legacy free-text "European" is exactly the value NZF rejects, so counting it
 *  as present would report a gap as closed when it isn't. */
export function nzfIdentityGap(contact: {
  countryOfBirthCode?: string | null;
  nationalityCode?: string | null;
  ethnicityGroupId?: number | null;
  addressStreet?: string | null;
  addressSuburb?: string | null;
  addressCity?: string | null;
  addressRegion?: string | null;
  addressPostcode?: string | null;
  addressCountry?: string | null;
}): IdentityGap {
  return {
    countryOfBirth: !contact.countryOfBirthCode,
    nationality: !contact.nationalityCode,
    ethnicity: typeof contact.ethnicityGroupId !== "number",
    address: !(
      contact.addressStreet &&
      contact.addressSuburb &&
      contact.addressCity &&
      contact.addressRegion &&
      contact.addressPostcode &&
      contact.addressCountry
    ),
  };
}

export function isNzfIdentityComplete(contact: Parameters<typeof nzfIdentityGap>[0]): boolean {
  const g = nzfIdentityGap(contact);
  return !g.countryOfBirth && !g.nationality && !g.ethnicity && !g.address;
}

// ── Deferral at the counter ─────────────────────────────────────────────────
// Office staff may skip the NZF fields so a parent is never blocked from
// paying — but only deliberately, with a reason, and the child then appears on
// the follow-up list. The reasons are the ones that actually come up at a
// counter; "Other" carries free text rather than forcing a wrong choice.

export const IDENTITY_DEFER_REASONS = [
  "Parent didn't know the answer",
  "Parent didn't have their address handy",
  "Registering on someone else's behalf",
  "Language barrier — needs a follow-up call",
  "Queue / no time at the counter",
  "Other",
] as const;
export type IdentityDeferReason = (typeof IDENTITY_DEFER_REASONS)[number];

export function isIdentityDeferReason(v: unknown): v is IdentityDeferReason {
  return typeof v === "string" && (IDENTITY_DEFER_REASONS as readonly string[]).includes(v);
}

/** A deferral must say WHY. An unexplained skip is the accidental gap this
 *  whole mechanism exists to replace, so a blank reason is refused — and
 *  "Other" must carry its own words rather than standing in for a shrug. */
export function validateIdentityDeferral(
  reason: unknown,
  note: unknown,
): { ok: true; reason: string } | { ok: false; error: string } {
  const r = typeof reason === "string" ? reason.trim() : "";
  const n = typeof note === "string" ? note.trim() : "";
  if (!r) return { ok: false, error: "Choose why the NZ Football details are being skipped." };
  if (!isIdentityDeferReason(r)) return { ok: false, error: "That isn't one of the skip reasons." };
  if (r === "Other" && !n) return { ok: false, error: "Add a short note explaining the skip." };
  return { ok: true, reason: r === "Other" ? `Other — ${n}` : n ? `${r} — ${n}` : r };
}
