// A local stand-in for Sporty's Football API v1.1, faithful to the swagger
// fetched 2026-07-21 (outputs/sporty-api-brief/ in the AIOS repo). Used by the
// test suites until NZ Football issues UAT keys — and kept afterwards so tests
// never depend on their UAT environment being up.
//
//   npx tsx script/mock-sporty.ts            # listens on 4599
//   MOCK_SPORTY_PORT=4600 npx tsx ...
//
// Behaviour matrix (drive scenarios from the request itself):
//  · /api/token: 401 unless apikey=mock-key & username=mock-user & password=mock-pass
//    and grant_type=password (form-urlencoded). Token expires per MOCK_TOKEN_TTL_S
//    (default 86399s) — set 2 to exercise the client's 401-refresh path.
//  · Every other endpoint: 401 without a valid Bearer token AND the apikey.
//  · RegisterPerson scenarios, keyed on FirstName (case-insensitive):
//      DUPLICATE     → 400 "Player already registered" + SportyId 90001
//                      …but a request WITH that SportyId succeeds (the retry path)
//      OVERSEAS      → 400 "Overseas clearance is required" + SportyId 90002
//      TERMINATION   → 400 "Termination required from Cashmere Technical" + SportyId 90003
//      REDFLAG       → 400 "Player is red flagged, Unpaid fees for Mainland Football" (no id)
//      SERVERBOOM    → 500 once, then 200 (exercises the 5xx retry)
//      anything else → validates required fields like the real thing, then 200
//    Validation mirrors the documented rules: required fields, Gender must be
//    exactly Male/Female/Non-binary, alpha-3 country codes, guardian fields
//    required for under-18 DOBs, MELAA needs ≥1 selection id.
//  · Rate limit: >2 POSTs or >2 GETs within any 1000ms window → 429 (per method,
//    like their published limits). Disable with MOCK_RATE_LIMIT=0.
//  · Reference endpoints serve realistic NZ vocab (incl. MELAA min 1 / max 3).

import express from "express";

const PORT = Number(process.env.MOCK_SPORTY_PORT || 4599);
let TOKEN_TTL_S = Number(process.env.MOCK_TOKEN_TTL_S || 86399);
const RATE_LIMIT_ON = process.env.MOCK_RATE_LIMIT !== "0";

/** Tests flip between a pathological TTL (to exercise re-auth) and the real
 *  24h one (RegisterPerson scenarios) — a 3s TTL plus rate-limit backoffs
 *  self-sustains a 401↔429 cycle no production client ever faces. */
export function setMockTokenTtl(seconds: number): void {
  TOKEN_TTL_S = seconds;
}

const API_KEY = "mock-key";
const USERNAME = "mock-user";
const PASSWORD = "mock-pass";

interface IssuedToken {
  token: string;
  expiresAt: number;
}
const issued: IssuedToken[] = [];
let tokenCounter = 0;
let serverBoomArmed = true;
let nextSportyId = 50001;
/** ExternalSystemId → SportyId, so re-registering the same person duplicates. */
const registered = new Map<string, number>();

const ETHNICITY_GROUPS = [
  {
    EthnicityGroupId: 1,
    EthnicityGroupName: "European",
    MinimumSelectionsRequired: 0,
    MaximumSelectionsRequired: 3,
    EthnicityGroupSelections: [
      { EthnicityGroupSelectionId: 101, EthnicityGroupSelectionName: "New Zealand European" },
      { EthnicityGroupSelectionId: 102, EthnicityGroupSelectionName: "British" },
      { EthnicityGroupSelectionId: 103, EthnicityGroupSelectionName: "Dutch" },
    ],
  },
  {
    EthnicityGroupId: 2,
    EthnicityGroupName: "Māori",
    MinimumSelectionsRequired: 0,
    MaximumSelectionsRequired: 3,
    EthnicityGroupSelections: [
      { EthnicityGroupSelectionId: 201, EthnicityGroupSelectionName: "Ngāi Tahu" },
      { EthnicityGroupSelectionId: 202, EthnicityGroupSelectionName: "Ngāpuhi" },
    ],
  },
  {
    EthnicityGroupId: 3,
    EthnicityGroupName: "Pacific Peoples",
    MinimumSelectionsRequired: 0,
    MaximumSelectionsRequired: 3,
    EthnicityGroupSelections: [
      { EthnicityGroupSelectionId: 301, EthnicityGroupSelectionName: "Samoan" },
      { EthnicityGroupSelectionId: 302, EthnicityGroupSelectionName: "Tongan" },
      { EthnicityGroupSelectionId: 303, EthnicityGroupSelectionName: "Fijian" },
    ],
  },
  {
    EthnicityGroupId: 4,
    EthnicityGroupName: "Asian",
    MinimumSelectionsRequired: 0,
    MaximumSelectionsRequired: 3,
    EthnicityGroupSelections: [
      { EthnicityGroupSelectionId: 401, EthnicityGroupSelectionName: "Chinese" },
      { EthnicityGroupSelectionId: 402, EthnicityGroupSelectionName: "Indian" },
      { EthnicityGroupSelectionId: 403, EthnicityGroupSelectionName: "Filipino" },
    ],
  },
  {
    EthnicityGroupId: 5,
    EthnicityGroupName: "MELAA",
    MinimumSelectionsRequired: 1,
    MaximumSelectionsRequired: 3,
    EthnicityGroupSelections: [
      { EthnicityGroupSelectionId: 501, EthnicityGroupSelectionName: "Middle Eastern" },
      { EthnicityGroupSelectionId: 502, EthnicityGroupSelectionName: "Latin American" },
      { EthnicityGroupSelectionId: 503, EthnicityGroupSelectionName: "African" },
    ],
  },
  {
    EthnicityGroupId: 6,
    EthnicityGroupName: "Other Ethnicity",
    MinimumSelectionsRequired: 0,
    MaximumSelectionsRequired: 3,
    EthnicityGroupSelections: [{ EthnicityGroupSelectionId: 601, EthnicityGroupSelectionName: "Other" }],
  },
];

const COUNTRIES = [
  { CountryCode: "NZL", CountryName: "New Zealand" },
  { CountryCode: "AUS", CountryName: "Australia" },
  { CountryCode: "GBR", CountryName: "United Kingdom" },
  { CountryCode: "USA", CountryName: "United States" },
  { CountryCode: "ZAF", CountryName: "South Africa" },
  { CountryCode: "FJI", CountryName: "Fiji" },
  { CountryCode: "WSM", CountryName: "Samoa" },
  { CountryCode: "TON", CountryName: "Tonga" },
  { CountryCode: "IND", CountryName: "India" },
  { CountryCode: "CHN", CountryName: "China" },
  { CountryCode: "JPN", CountryName: "Japan" },
  { CountryCode: "BRA", CountryName: "Brazil" },
  { CountryCode: "ARG", CountryName: "Argentina" },
  { CountryCode: "DEU", CountryName: "Germany" },
  { CountryCode: "IRL", CountryName: "Ireland" },
  { CountryCode: "PHL", CountryName: "Philippines" },
  { CountryCode: "SOM", CountryName: "Somalia" },
];

const GENDERS = ["Male", "Female", "Non-binary"];

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Rate limiting: per-method sliding 1s window, limit 2 (matches their docs) ──
const windows: Record<string, number[]> = { GET: [], POST: [] };
app.use((req, res, next) => {
  if (!RATE_LIMIT_ON) return next();
  const now = Date.now();
  const win = windows[req.method] ?? (windows[req.method] = []);
  while (win.length && now - win[0] > 1000) win.shift();
  if (win.length >= 2) {
    res.status(429).json({ Message: "Too Many Requests" });
    return;
  }
  win.push(now);
  next();
});

function validToken(req: express.Request): boolean {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  const found = issued.find((t) => t.token === token);
  return !!found && Date.now() < found.expiresAt;
}

function requireAuthd(req: express.Request, res: express.Response): boolean {
  const key = String(req.query.apikey || req.headers.apikey || "");
  if (key !== API_KEY || !validToken(req)) {
    res.status(401).json({ Message: "Unauthorized" });
    return false;
  }
  return true;
}

app.post("/api/token", (req, res) => {
  const key = String(req.query.apikey || "");
  const { username, password, grant_type } = req.body ?? {};
  if (key !== API_KEY || username !== USERNAME || password !== PASSWORD || grant_type !== "password") {
    res.status(401).json({ Message: "Unauthorized" });
    return;
  }
  const token = `mock-jwt-${++tokenCounter}-${Math.random().toString(36).slice(2)}`;
  issued.push({ token, expiresAt: Date.now() + TOKEN_TTL_S * 1000 });
  res.json({ access_token: token, token_type: "bearer", expires_in: TOKEN_TTL_S });
});

function isMinorDob(dob: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob || "");
  if (!m) return false;
  const now = new Date();
  let age = now.getFullYear() - Number(m[1]);
  if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) age -= 1;
  return age < 18;
}

app.post("/api/v1/football/RegisterPerson", (req, res) => {
  if (!requireAuthd(req, res)) return;
  const b = req.body ?? {};
  const first = String(b.FirstName || "").toUpperCase();

  // Scenario switches first — they model Sporty-side conditions, not input validation.
  if (first === "DUPLICATE" && !b.SportyId) {
    res.status(400).json({ Message: "Player already registered", SportyId: 90001 });
    return;
  }
  if (first === "OVERSEAS") {
    res.status(400).json({ Message: "Overseas clearance is required", SportyId: 90002 });
    return;
  }
  if (first === "TERMINATION") {
    res.status(400).json({ Message: "Termination required from Cashmere Technical", SportyId: 90003 });
    return;
  }
  if (first === "REDFLAG") {
    res.status(400).json({ Message: "Player is red flagged, Unpaid fees for Mainland Football" });
    return;
  }
  if (first === "SERVERBOOM" && serverBoomArmed) {
    serverBoomArmed = false;
    res.status(500).json({ Message: "Internal Server Error" });
    return;
  }

  // Documented required-field validation.
  const required: Array<[string, string]> = [
    ["FirstName", "First Name"],
    ["FamilyName", "Family Name"],
    ["DateOfBirth", "Date Of Birth"],
    ["Gender", "Gender"],
    ["NationalityCode", "Nationality"],
    ["CountryOfBirthCode", "Country Of Birth"],
    ["MobilePhone", "Mobile Phone"],
    ["Email", "Email"],
    ["PrimaryEthnicityGroupName", "Primary Ethnicity Group"],
  ];
  for (const [field, label] of required) {
    if (!b[field] || !String(b[field]).trim()) {
      res.status(400).json({ Message: `${label} is required` });
      return;
    }
  }
  if (!b.Address || typeof b.Address !== "object") {
    res.status(400).json({ Message: "Address is required" });
    return;
  }
  if (!GENDERS.includes(b.Gender)) {
    res.status(400).json({ Message: "Invalid Gender" });
    return;
  }
  for (const field of ["NationalityCode", "CountryOfBirthCode"]) {
    if (!COUNTRIES.some((c) => c.CountryCode === b[field])) {
      res.status(400).json({ Message: `Invalid ${field}` });
      return;
    }
  }
  const group = ETHNICITY_GROUPS.find((g) => g.EthnicityGroupName === b.PrimaryEthnicityGroupName);
  if (!group) {
    res.status(400).json({ Message: "Invalid Primary Ethnicity Group" });
    return;
  }
  const selections: number[] = Array.isArray(b.PrimaryEthnicityGroupSelectionIds) ? b.PrimaryEthnicityGroupSelectionIds : [];
  if (selections.length < group.MinimumSelectionsRequired) {
    res.status(400).json({ Message: `At least ${group.MinimumSelectionsRequired} selection(s) required for ${group.EthnicityGroupName}` });
    return;
  }
  if (selections.length > group.MaximumSelectionsRequired) {
    res.status(400).json({ Message: `No more than ${group.MaximumSelectionsRequired} selection(s) allowed for ${group.EthnicityGroupName}` });
    return;
  }
  if (isMinorDob(String(b.DateOfBirth))) {
    for (const [field, label] of [
      ["ParentGuardian1FirstName", "Parent Guardian First Name"],
      ["ParentGuardian1LastName", "Parent Guardian Last Name"],
      ["ParentGuardian1Email", "Parent Guardian Email"],
      ["ParentGuardian1Phone", "Parent Guardian Phone"],
    ] as const) {
      if (!b[field] || !String(b[field]).trim()) {
        res.status(400).json({ Message: `${label} is required` });
        return;
      }
    }
  }

  // Update path: SportyId must be known to us (or a scenario id).
  let sportyId: number;
  if (b.SportyId != null) {
    const known =
      [90001, 90002, 90003].includes(Number(b.SportyId)) ||
      Array.from(registered.values()).includes(Number(b.SportyId));
    if (!known) {
      res.status(400).json({ Message: "Invalid SportyId" });
      return;
    }
    sportyId = Number(b.SportyId);
  } else {
    // Duplicate detection on ExternalSystemId — mirrors "Player already registered".
    const ext = String(b.ExternalSystemId || "");
    const existing = ext ? registered.get(ext) : undefined;
    if (existing) {
      res.status(400).json({ Message: "Player already registered", SportyId: existing });
      return;
    }
    sportyId = nextSportyId++;
    if (ext) registered.set(ext, sportyId);
  }

  res.json({
    PersonFifaId: `FIFA-${sportyId}`,
    SportyId: sportyId,
    ...b,
    DateFrom: new Date().toISOString(),
    Active: true,
  });
});

app.get("/api/v1/football/ethnicity/GetEthnicityGroups", (req, res) => {
  if (!requireAuthd(req, res)) return;
  res.json(ETHNICITY_GROUPS);
});
app.get("/api/v1/football/country/GetCountries", (req, res) => {
  if (!requireAuthd(req, res)) return;
  res.json(COUNTRIES);
});
app.get("/api/v1/football/gender/GetGenders", (req, res) => {
  if (!requireAuthd(req, res)) return;
  res.json(GENDERS);
});
app.get("/api/v1/football/fantail/GetFormOptions", (req, res) => {
  if (!requireAuthd(req, res)) return;
  res.json({
    AgeGroups: [{ Id: 1, Name: "4-6 years" }, { Id: 2, Name: "7-9 years" }],
    Terms: [{ Id: 11, Name: "Term 3 2026" }, { Id: 12, Name: "Term 4 2026" }],
    HasPlayedFootballOrFutsalBeforeOptions: [{ Id: 21, Name: "Yes" }, { Id: 22, Name: "No" }],
    HowHeardAboutProgrammeOptions: [{ Id: 31, Name: "School" }, { Id: 32, Name: "Social media" }],
    AttractionToProgrammeOptions: [{ Id: 41, Name: "Fun" }, { Id: 42, Name: "Fitness" }],
  });
});

if (process.argv[1] && process.argv[1].includes("mock-sporty")) {
  app.listen(PORT, () => console.log(`[mock-sporty] listening on http://localhost:${PORT} (apikey=${API_KEY}, user=${USERNAME})`));
}

export { app as mockSportyApp, API_KEY as MOCK_API_KEY, USERNAME as MOCK_USERNAME, PASSWORD as MOCK_PASSWORD };
