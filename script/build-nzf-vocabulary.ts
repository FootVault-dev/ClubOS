// Regenerates shared/nzf-vocabulary.ts from Sporty's OWN reference endpoints.
//
// Why a checked-in snapshot rather than a live call:
//   The public registration form must render its dropdowns with no Sporty
//   credentials, no network call and no database row. Production has no
//   SPORTY_* secrets today, so a form that fetched this vocabulary live would
//   render EMPTY selects on prod — i.e. it would break the paying checkout to
//   satisfy a compliance field. The snapshot is the floor; the reference cache
//   (when an environment has one) is an upgrade on top of it.
//
// Re-run whenever NZ Football changes their lists:
//   npx tsx --env-file=.env script/build-nzf-vocabulary.ts
//
// 🔴 Writes a source file. Read the diff before committing — a silent
// vocabulary change is a silent change to what families can say about
// themselves.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SportyClient, readSportyConfig } from "../server/sporty-client";
import { sportyEnvironmentFor } from "../shared/sporty";

async function main() {
  const cfg = readSportyConfig();
  if (!cfg) {
    console.error(
      "No Sporty config. Set SPORTY_BASE_URL / SPORTY_API_KEY / SPORTY_API_USERNAME / SPORTY_API_PASSWORD.",
    );
    process.exit(1);
  }

  const env = sportyEnvironmentFor(cfg.baseUrl);
  console.log(`Fetching reference data from ${cfg.baseUrl} (environment '${env}')…`);

  const client = new SportyClient(cfg);
  const [countries, genders, groups] = await Promise.all([
    client.getCountries(),
    client.getGenders(),
    client.getEthnicityGroups(),
  ]);

  // Sanity gates — a truncated or empty response must never overwrite a good
  // snapshot. These numbers are floors observed against the real API, not
  // guesses; if NZF genuinely shrinks a list below one, that's a human decision.
  if (countries.length < 200) throw new Error(`Only ${countries.length} countries returned — refusing to write a truncated list.`);
  if (groups.length < 5) throw new Error(`Only ${groups.length} ethnicity groups returned — refusing to write a truncated list.`);
  if (genders.length < 2) throw new Error(`Only ${genders.length} genders returned — refusing to write a truncated list.`);
  if (!countries.some((c) => c.CountryCode === "NZL")) throw new Error("NZL missing from the country list — refusing to write.");

  const sortedCountries = [...countries].sort((a, b) => a.CountryName.localeCompare(b.CountryName));
  const sortedGroups = [...groups].sort((a, b) => a.EthnicityGroupId - b.EthnicityGroupId);

  const lines: string[] = [];
  lines.push(`// GENERATED FILE — do not edit by hand.`);
  lines.push(`// Source: Sporty (NZ Football NRS) reference endpoints, environment '${env}'.`);
  lines.push(`// Regenerate: npx tsx --env-file=.env script/build-nzf-vocabulary.ts`);
  lines.push(`//`);
  lines.push(`// This is the vocabulary NZ Football actually accepts. The registration form`);
  lines.push(`// offers exactly these values, so a parent's answer is already valid at the`);
  lines.push(`// point they give it — there is no mapping step left to guess wrong.`);
  lines.push(`//`);
  lines.push(`// 🔴 Country codes here are FIFA/IOC, NOT ISO 3166-1 alpha-3 (Samoa is SAM not`);
  lines.push(`// WSM, Germany GER not DEU). Always read a code off this list.`);
  lines.push(``);
  lines.push(`export interface NzfCountry { code: string; name: string }`);
  lines.push(`export interface NzfEthnicitySelection { id: number; name: string }`);
  lines.push(`export interface NzfEthnicityGroup {`);
  lines.push(`  id: number;`);
  lines.push(`  name: string;`);
  lines.push(`  /** Minimum specific selections the group requires. 0 = none needed. */`);
  lines.push(`  minSelections: number;`);
  lines.push(`  /** Maximum allowed. 0 = the group takes no selections at all. */`);
  lines.push(`  maxSelections: number;`);
  lines.push(`  selections: NzfEthnicitySelection[];`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export const NZF_VOCABULARY_SOURCE = ${JSON.stringify(env)} as const;`);
  lines.push(`export const NZF_VOCABULARY_FETCHED_AT = ${JSON.stringify(new Date().toISOString().slice(0, 10))} as const;`);
  lines.push(``);
  lines.push(`export const NZF_COUNTRIES: readonly NzfCountry[] = ${JSON.stringify(
    sortedCountries.map((c) => ({ code: c.CountryCode, name: c.CountryName })),
    null,
    2,
  )} as const;`);
  lines.push(``);
  lines.push(`export const NZF_GENDERS: readonly string[] = ${JSON.stringify(genders, null, 2)} as const;`);
  lines.push(``);
  lines.push(`export const NZF_ETHNICITY_GROUPS: readonly NzfEthnicityGroup[] = ${JSON.stringify(
    sortedGroups.map((g) => ({
      id: g.EthnicityGroupId,
      name: g.EthnicityGroupName,
      minSelections: g.MinimumSelectionsRequired,
      maxSelections: g.MaximumSelectionsRequired,
      selections: [...g.EthnicityGroupSelections]
        .sort((a, b) => a.EthnicityGroupSelectionName.localeCompare(b.EthnicityGroupSelectionName))
        .map((s) => ({ id: s.EthnicityGroupSelectionId, name: s.EthnicityGroupSelectionName })),
    })),
    null,
    2,
  )} as const;`);
  lines.push(``);

  const out = resolve(import.meta.dirname, "../shared/nzf-vocabulary.ts");
  writeFileSync(out, lines.join("\n"), "utf8");

  console.log(`\n✓ Wrote ${out}`);
  console.log(`  countries        : ${sortedCountries.length}`);
  console.log(`  genders          : ${genders.join(", ")}`);
  console.log(`  ethnicity groups : ${sortedGroups.length}`);
  for (const g of sortedGroups) {
    console.log(
      `    · ${g.EthnicityGroupName} (id ${g.EthnicityGroupId}) — ${g.MinimumSelectionsRequired}–${g.MaximumSelectionsRequired} of ${g.EthnicityGroupSelections.length}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
