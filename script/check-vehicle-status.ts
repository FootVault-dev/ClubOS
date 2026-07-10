// Asserts the fleet status maths. ClubOS has no test runner, so this follows
// the house `script/apply-*.ts` idiom: run it, it prints and exits 1 on failure.
//
//   npx tsx script/check-vehicle-status.ts
//
// It exists because this repo has already shipped one calendar-date bug: an
// invoice due the 17th rendered "18 July" because an ISO date was round-tripped
// through a `Date`. Every case below is a date that has historically bitten us
// somewhere — month boundaries, leap days, year rollovers, and the off-by-one
// on "expires today".

import {
  daysUntil,
  expiryStatus,
  rucStatus,
  worstStatus,
  odometerIsStale,
  vehicleCompliance,
  insuranceStatus,
  suggestRucRequired,
  DUE_SOON_DAYS,
} from "../shared/vehicles";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

console.log("\ndaysUntil — calendar arithmetic, no Date round-trip");
check("same day", daysUntil("2026-07-10", "2026-07-10"), 0);
check("tomorrow", daysUntil("2026-07-11", "2026-07-10"), 1);
check("yesterday", daysUntil("2026-07-09", "2026-07-10"), -1);
check("across a month boundary (27 Feb → 1 Mar, non-leap)", daysUntil("2027-03-01", "2027-02-27"), 2);
check("across a leap day (27 Feb → 1 Mar 2028)", daysUntil("2028-03-01", "2028-02-27"), 3);
check("29 Feb exists in 2028", daysUntil("2028-02-29", "2028-02-28"), 1);
check("across a year boundary", daysUntil("2027-01-01", "2026-12-31"), 1);
check("a full non-leap year", daysUntil("2027-07-10", "2026-07-10"), 365);
check("across NZDT→NZST (DST ends 5 Apr 2026)", daysUntil("2026-04-06", "2026-04-04"), 2);
check("rejects 31 February", daysUntil("2026-02-31", "2026-07-10"), null);
check("rejects garbage", daysUntil("not-a-date", "2026-07-10"), null);
check("rejects a timestamp", daysUntil("2026-07-10T00:00:00Z", "2026-07-10"), null);

console.log("\nexpiryStatus — valid THROUGH the expiry date");
check("expires today is due_soon, not expired", expiryStatus("2026-07-10", "2026-07-10"), "due_soon");
check("expired yesterday", expiryStatus("2026-07-09", "2026-07-10"), "expired");
check("last day of the amber window", expiryStatus("2026-08-09", "2026-07-10"), "due_soon");
check("one day past the amber window", expiryStatus("2026-08-10", "2026-07-10"), "ok");
check("missing date is unknown, never ok", expiryStatus(null, "2026-07-10"), "unknown");
check("empty string is unknown", expiryStatus("", "2026-07-10"), "unknown");
check("amber window is 30 days", DUE_SOON_DAYS, 30);

console.log("\nrucStatus — distance, not time");
const fresh = "2026-07-01";
check("not required → ok", rucStatus({ rucRequired: false, rucValidToKm: null, odometerKm: null, odometerAt: null }, "2026-07-10"), "ok");
check("no licence recorded → unknown", rucStatus({ rucRequired: true, rucValidToKm: null, odometerKm: 50_000, odometerAt: fresh }, "2026-07-10"), "unknown");
check("2,000km of headroom → ok", rucStatus({ rucRequired: true, rucValidToKm: 52_000, odometerKm: 50_000, odometerAt: fresh }, "2026-07-10"), "ok");
check("900km of headroom → due_soon", rucStatus({ rucRequired: true, rucValidToKm: 50_900, odometerKm: 50_000, odometerAt: fresh }, "2026-07-10"), "due_soon");
check("odometer past the licence → expired", rucStatus({ rucRequired: true, rucValidToKm: 50_000, odometerKm: 50_100, odometerAt: fresh }, "2026-07-10"), "expired");
check("exactly at the licence → expired", rucStatus({ rucRequired: true, rucValidToKm: 50_000, odometerKm: 50_000, odometerAt: fresh }, "2026-07-10"), "expired");
check(
  "stale reading with headroom → unknown, NOT a reassuring ok",
  rucStatus({ rucRequired: true, rucValidToKm: 60_000, odometerKm: 50_000, odometerAt: "2026-01-01" }, "2026-07-10"),
  "unknown",
);
check(
  "stale reading already over the licence → still expired",
  rucStatus({ rucRequired: true, rucValidToKm: 50_000, odometerKm: 55_000, odometerAt: "2026-01-01" }, "2026-07-10"),
  "expired",
);

console.log("\nodometerIsStale");
check("never read → stale", odometerIsStale(null, "2026-07-10"), true);
check("read today → fresh", odometerIsStale("2026-07-10", "2026-07-10"), false);
check("90 days old → fresh (boundary)", odometerIsStale("2026-04-11", "2026-07-10"), false);
check("91 days old → stale", odometerIsStale("2026-04-10", "2026-07-10"), true);

console.log("\nworstStatus — unknown outranks ok");
check("empty → ok", worstStatus([]), "ok");
check("ok + unknown → unknown", worstStatus(["ok", "unknown"]), "unknown");
check("unknown + due_soon → due_soon", worstStatus(["unknown", "due_soon"]), "due_soon");
check("due_soon + expired → expired", worstStatus(["due_soon", "expired"]), "expired");
check("expired beats everything", worstStatus(["expired", "ok", "unknown", "due_soon"]), "expired");

console.log("\nsuggestRucRequired");
check("diesel pays RUC", suggestRucRequired("diesel"), true);
check("electric pays RUC", suggestRucRequired("electric"), true);
check("plug-in hybrid pays RUC", suggestRucRequired("plug_in_hybrid"), true);
check("petrol does not", suggestRucRequired("petrol"), false);
check("petrol hybrid does not", suggestRucRequired("hybrid"), false);

console.log("\ninsuranceStatus — cover is judged as at today, then follows renewals");
const TODAY = "2026-07-10";
check("no policy ever → unknown", insuranceStatus([], TODAY), { status: "unknown", expiresOn: null });
check(
  "covered, expires far away → ok",
  insuranceStatus([{ startsOn: "2026-01-01", expiresOn: "2027-01-01" }], TODAY),
  { status: "ok", expiresOn: "2027-01-01" },
);
check(
  "covered, expires in 5 days → due_soon",
  insuranceStatus([{ startsOn: "2025-07-15", expiresOn: "2026-07-15" }], TODAY),
  { status: "due_soon", expiresOn: "2026-07-15" },
);
check(
  "renewal starts the DAY AFTER expiry → follows it through, no false amber",
  insuranceStatus(
    [
      { startsOn: "2025-07-15", expiresOn: "2026-07-15" },
      { startsOn: "2026-07-16", expiresOn: "2027-07-15" },
    ],
    TODAY,
  ),
  { status: "ok", expiresOn: "2027-07-15" },
);
check(
  "renewal starts the SAME day it expires → also contiguous",
  insuranceStatus(
    [
      { startsOn: "2025-07-15", expiresOn: "2026-07-15" },
      { startsOn: "2026-07-15", expiresOn: "2027-07-15" },
    ],
    TODAY,
  ),
  { status: "ok", expiresOn: "2027-07-15" },
);
check(
  "a ONE clear day gap is a real gap → still amber on the near policy",
  insuranceStatus(
    [
      { startsOn: "2025-07-15", expiresOn: "2026-07-15" },
      { startsOn: "2026-07-17", expiresOn: "2027-07-15" },
    ],
    TODAY,
  ),
  { status: "due_soon", expiresOn: "2026-07-15" },
);
check(
  "three contiguous policies chain all the way through",
  insuranceStatus(
    [
      { startsOn: "2026-07-01", expiresOn: "2026-07-31" },
      { startsOn: "2026-08-01", expiresOn: "2026-08-31" },
      { startsOn: "2026-09-01", expiresOn: "2028-01-01" },
    ],
    TODAY,
  ),
  { status: "ok", expiresOn: "2028-01-01" },
);
check(
  "lapsed cover → expired, showing the lapse date",
  insuranceStatus([{ startsOn: "2024-01-01", expiresOn: "2025-01-01" }], TODAY),
  { status: "expired", expiresOn: "2025-01-01" },
);
check(
  "FUTURE-only policy → expired today, NOT a green badge on an uninsured van",
  insuranceStatus([{ startsOn: "2026-09-01", expiresOn: "2027-09-01" }], TODAY),
  { status: "expired", expiresOn: null },
);
check(
  "lapsed, with a future renewal booked → still uninsured TODAY",
  insuranceStatus(
    [
      { startsOn: "2024-01-01", expiresOn: "2025-01-01" },
      { startsOn: "2026-09-01", expiresOn: "2027-09-01" },
    ],
    TODAY,
  ),
  { status: "expired", expiresOn: "2025-01-01" },
);
check("garbage dates are ignored, not crashed on", insuranceStatus([{ startsOn: "nope", expiresOn: "2027-01-01" }], TODAY), {
  status: "unknown",
  expiresOn: null,
});

console.log("\nvehicleCompliance — rollup");
const base = {
  status: "active",
  complianceType: "wof",
  wofExpiresOn: "2027-01-01",
  cofExpiresOn: null,
  regoExpiresOn: "2027-01-01",
  rucRequired: false,
  rucValidToKm: null,
  odometerKm: 10_000,
  odometerAt: "2026-07-10",
  nextServiceDueOn: "2027-01-01",
};
const covered = [{ startsOn: "2026-01-01", expiresOn: "2027-01-01" }];
check("all clear → ok", vehicleCompliance(base, covered, TODAY).overall, "ok");
check("expired rego drives overall", vehicleCompliance({ ...base, regoExpiresOn: "2026-07-01" }, covered, TODAY).overall, "expired");
check("missing WOF date → unknown overall", vehicleCompliance({ ...base, wofExpiresOn: null }, covered, TODAY).overall, "unknown");
check("no insurance recorded → unknown overall", vehicleCompliance(base, [], TODAY).overall, "unknown");
check("lapsed insurance → expired overall", vehicleCompliance(base, [{ startsOn: "2024-01-01", expiresOn: "2025-01-01" }], TODAY).overall, "expired");
check(
  "COF vehicle reads cofExpiresOn, ignores a stale wof column",
  vehicleCompliance({ ...base, complianceType: "cof", cofExpiresOn: "2026-07-01", wofExpiresOn: "2030-01-01" }, covered, TODAY).compliance,
  "expired",
);
check(
  "COF vehicle is labelled COF",
  vehicleCompliance({ ...base, complianceType: "cof", cofExpiresOn: "2027-01-01" }, covered, TODAY).complianceLabel,
  "COF",
);
check("missing next-service date is not a nag", vehicleCompliance({ ...base, nextServiceDueOn: null }, covered, TODAY).service, "ok");
check(
  "a disposed vehicle never nags",
  vehicleCompliance({ ...base, status: "disposed", wofExpiresOn: "2020-01-01", regoExpiresOn: null }, [], TODAY).overall,
  "ok",
);
check(
  "odometerStale only flags when RUC actually applies",
  vehicleCompliance({ ...base, odometerAt: "2026-01-01" }, covered, TODAY).odometerStale,
  false,
);
check(
  "odometerStale flags a diesel with a four-month-old reading",
  vehicleCompliance({ ...base, rucRequired: true, rucValidToKm: 50_000, odometerAt: "2026-01-01" }, covered, TODAY).odometerStale,
  true,
);

console.log("");
if (failures) {
  console.error(`✗ ${failures} assertion(s) failed\n`);
  process.exit(1);
}
console.log("✓ all vehicle status assertions passed\n");
