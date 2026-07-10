// Club-name canonicalisation for the CIC Skills Challenge picker.
//
// Parents typed their own club name into the public registration form, so the
// same club arrives spelled several ways: "Twenty 11 FC", "Fc twenty 11" and
// "Fc 2011" are one club; so are "RH3 Academy", "RH3 Football Academy" and
// "RH3 Football Acacdemy". Left alone, the scorer picks a club and sees only
// a third of its players.
//
// This groups them FOR THE PICKER ONLY. An existing entry always displays the
// club name the parent actually typed — we never rewrite their registration.
// New entries created from the picker are stored under the canonical name.
//
// The map is deliberately explicit rather than fuzzy: a fuzzy matcher would
// happily merge "Nelson Suburbs" into "Western Suburbs". Every pair below was
// read off the live table by eye. Add to it as new spellings appear.

/** Lowercase, collapse whitespace, drop a trailing FC/AFC. Catches case-only
 *  variants ("Nomads united" / "Nomads United") without any guessing. */
export function normalizeClub(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+(fc|afc)$/, "");
}

/** normalized spelling -> canonical display name. */
const CLUB_ALIASES: Record<string, string> = {
  // "2011" is how some parents write "twenty 11".
  "fc 2011": "Twenty 11 FC",
  "fc twenty 11": "Twenty 11 FC",
  "twenty 11": "Twenty 11 FC",

  // Word order reversed on one, suffix on another.
  "nelson suburbs": "Nelson Suburbs",
  "suburbs nelson": "Nelson Suburbs",

  // Suffix only.
  "nomads united": "Nomads United",

  // Acronym + full legal name.
  qafc: "Queenstown AFC",
  queenstown: "Queenstown AFC",
  "queenstown association football club": "Queenstown AFC",

  // "Acacdemy" is a typo; "RH3 Academy" drops the word Football.
  "rh3 academy": "RH3 Football Academy",
  "rh3 football acacdemy": "RH3 Football Academy",
  "rh3 football academy": "RH3 Football Academy",

  // Speech-to-text mangling of "Future Stars Academy".
  "future stars academy": "Future Stars Academy",
  "futurity starts academy": "Future Stars Academy",
};

/** The name this club should be grouped and stored under. */
export function canonicalClub(name: string): string {
  const key = normalizeClub(name);
  if (CLUB_ALIASES[key]) return CLUB_ALIASES[key];
  return name.trim().replace(/\s+/g, " ");
}

/** True when two typed club names are the same club. */
export function sameClub(a: string, b: string): boolean {
  return canonicalClub(a).toLowerCase() === canonicalClub(b).toLowerCase();
}
