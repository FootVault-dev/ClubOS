// ─────────────────────────────────────────────────────────────────────────────
// FINES — paid and unpaid fines, both directions, with their paperwork.
//
//   GET|POST          /api/admin/fines
//   GET|PATCH|DELETE  /api/admin/fines/:id
//   POST              /api/admin/fines/:id/attachments        (multipart, field "file")
//   GET               /api/admin/fines/:id/attachments/:aid   (302 → short-lived signed URL)
//   DELETE            /api/admin/fines/:id/attachments/:aid
//   GET               /api/admin/fines/driver-hint            (?vehicleId=&on=)
//
// Access. `requireAuth` + `requireTab("fines")`, and "fines" is in
// SUPER_ADMIN_ONLY_TABS — checked FIRST, before the usual admin/manager
// escalation, so the tab is locked at the API and not merely hidden in the
// sidebar. Daniel reaches it as a super admin; Travis by name through
// `user_organizations.unlocked_tabs`. Deleting the slug from that set would
// open it to every United Sports Group admin, which is exactly what this
// register must not do — it names people against money they owe.
//
// Org scoping. `organizationId` always comes from the X-Workspace-Slug header,
// never from the request body. Every child row is reachable only by
// (id AND fineId AND organizationId), so guessing an id cannot cross a
// workspace.
//
// Money is in cents, integers only. Dates are ISO calendar strings and are
// never round-tripped through a `Date` — see shared/fines.ts.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import multer from "multer";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import {
  organizations, fines, fineAttachments, contacts, fleetVehicles, users, fleetAssignments,
} from "@shared/schema";
import { nzTodayIso } from "@shared/academy";
import { driveStorage } from "./drive-storage";
import {
  isFineDirection, isFineCategory, isFineAttachmentKind, isIsoDate,
  fineStatus, summariseFines,
} from "@shared/fines";

// A fine notice is a photo or a PDF, and a payment confirmation is a screenshot
// or a bank receipt. 25MB is far above any of those and well below the point
// where holding one in memory matters.
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES } });

class BadRequest extends Error {}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length ? s : null;
};
const reqStr = (v: unknown, field: string): string => {
  const s = str(v);
  if (!s) throw new BadRequest(`${field} is required`);
  return s;
};
/** ISO calendar date or null. Rejects anything else rather than coercing — a
 *  `new Date("12/08/2026")` is a different day in half the world. */
const dateOrNull = (v: unknown, field: string): string | null => {
  const s = str(v);
  if (!s) return null;
  if (!isIsoDate(s)) throw new BadRequest(`${field} must be a date`);
  return s;
};
const centsOrNull = (v: unknown, field: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) throw new BadRequest(`${field} must be a whole number of cents`);
  if (n < 0) throw new BadRequest(`${field} cannot be negative`);
  return n;
};
const idOrNull = (v: unknown, field: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`${field} is not a valid id`);
  return n;
};

async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

/** Shape one row for the client, with its status already computed. The client
 *  never recomputes a status — it only colours the one it is given. */
type PersonLite = { id: number; name: string } | null;
type VehicleLite = { id: number; plate: string; label: string } | null;

function shape(
  f: typeof fines.$inferSelect,
  todayIso: string,
  person: PersonLite,
  vehicle: VehicleLite,
  attachments: Array<typeof fineAttachments.$inferSelect>,
  createdByName: string | null,
) {
  const status = fineStatus({ paidOn: f.paidOn, waivedOn: f.waivedOn, dueOn: f.dueOn }, todayIso);
  return {
    id: f.id,
    direction: f.direction,
    category: f.category,
    reference: f.reference,
    counterparty: f.counterparty,
    description: f.description,
    person,
    vehicle,
    amountCents: f.amountCents,
    offenceOn: f.offenceOn,
    issuedOn: f.issuedOn,
    dueOn: f.dueOn,
    paidOn: f.paidOn,
    paidReference: f.paidReference,
    waivedOn: f.waivedOn,
    waivedReason: f.waivedReason,
    notes: f.notes,
    status,
    createdByName,
    createdAt: f.createdAt,
    attachments: attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      uploadedAt: a.uploadedAt,
    })),
  };
}

/** Load a page of fines with everything they reference, in a fixed number of
 *  queries rather than one per row. */
async function loadFines(orgId: number, todayIso: string, whereId?: number) {
  const rows = await db
    .select()
    .from(fines)
    .where(whereId ? and(eq(fines.organizationId, orgId), eq(fines.id, whereId)) : eq(fines.organizationId, orgId))
    .orderBy(desc(fines.issuedOn), desc(fines.id));
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const personIds = Array.from(new Set(rows.map((r) => r.personContactId).filter((v): v is number => !!v)));
  const vehicleIds = Array.from(new Set(rows.map((r) => r.vehicleId).filter((v): v is number => !!v)));
  const creatorIds = Array.from(new Set(rows.map((r) => r.createdBy).filter((v): v is number => !!v)));

  // `inArray` on an empty list generates `in ()`, which is a syntax error — the
  // same footgun that made `= ANY()` banned in the sponsor-traffic work.
  const [atts, people, vehicles, creators] = await Promise.all([
    db.select().from(fineAttachments).where(inArray(fineAttachments.fineId, ids)).orderBy(asc(fineAttachments.uploadedAt)),
    personIds.length ? db.select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName }).from(contacts).where(inArray(contacts.id, personIds)) : Promise.resolve([]),
    vehicleIds.length ? db.select({ id: fleetVehicles.id, plate: fleetVehicles.plate, make: fleetVehicles.make, model: fleetVehicles.model }).from(fleetVehicles).where(inArray(fleetVehicles.id, vehicleIds)) : Promise.resolve([]),
    creatorIds.length ? db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, creatorIds)) : Promise.resolve([]),
  ]);

  const personById = new Map(people.map((p: any) => [p.id, { id: p.id, name: [p.firstName, p.lastName].filter(Boolean).join(" ") || `Contact ${p.id}` }]));
  const vehicleById = new Map(vehicles.map((v: any) => [v.id, { id: v.id, plate: v.plate, label: `${v.plate} · ${v.make} ${v.model}` }]));
  const creatorById = new Map(creators.map((u: any) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(" ") || null]));
  const attsByFine = new Map<number, Array<typeof fineAttachments.$inferSelect>>();
  for (const a of atts) {
    const list = attsByFine.get(a.fineId) ?? [];
    list.push(a);
    attsByFine.set(a.fineId, list);
  }

  return rows.map((f) =>
    shape(
      f, todayIso,
      f.personContactId ? personById.get(f.personContactId) ?? null : null,
      f.vehicleId ? vehicleById.get(f.vehicleId) ?? null : null,
      attsByFine.get(f.id) ?? [],
      f.createdBy ? creatorById.get(f.createdBy) ?? null : null,
    ),
  );
}

/** Read the writable fields off a request body. Used by create and update, so
 *  the two can never validate differently. */
function readBody(body: any, { partial }: { partial: boolean }) {
  const patch: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body ?? {}, k);

  if (!partial || has("direction")) {
    const d = reqStr(body?.direction, "Direction");
    if (!isFineDirection(d)) throw new BadRequest("Direction must be club_owes or owed_to_club");
    patch.direction = d;
  }
  if (!partial || has("category")) {
    const c = str(body?.category) ?? "other";
    if (!isFineCategory(c)) throw new BadRequest("Unknown category");
    patch.category = c;
  }
  if (!partial || has("counterparty")) patch.counterparty = reqStr(body?.counterparty, "Who it is from/for");
  if (!partial || has("amountCents")) {
    const amount = centsOrNull(body?.amountCents, "Amount");
    if (amount === null) throw new BadRequest("Amount is required");
    patch.amountCents = amount;
  }
  if (has("reference")) patch.reference = str(body?.reference);
  if (has("description")) patch.description = str(body?.description);
  if (has("notes")) patch.notes = str(body?.notes);
  if (has("personContactId")) patch.personContactId = idOrNull(body?.personContactId, "Person");
  if (has("vehicleId")) patch.vehicleId = idOrNull(body?.vehicleId, "Vehicle");
  if (has("offenceOn")) patch.offenceOn = dateOrNull(body?.offenceOn, "Offence date");
  if (has("issuedOn")) patch.issuedOn = dateOrNull(body?.issuedOn, "Issued date");
  if (has("dueOn")) patch.dueOn = dateOrNull(body?.dueOn, "Due date");
  if (has("paidOn")) patch.paidOn = dateOrNull(body?.paidOn, "Paid date");
  if (has("paidReference")) patch.paidReference = str(body?.paidReference);
  if (has("waivedOn")) patch.waivedOn = dateOrNull(body?.waivedOn, "Waived date");
  if (has("waivedReason")) patch.waivedReason = str(body?.waivedReason);
  return patch;
}

export function registerFinesRoutes(app: Express) {
  const gate = [requireAuth, requireTab("fines")] as const;

  const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (e: any) {
        if (e instanceof BadRequest) { res.status(400).json({ message: e.message }); return; }
        console.error("[fines]", e);
        res.status(500).json({ message: e?.message ?? "Something went wrong" });
      }
    };

  // ── List ───────────────────────────────────────────────────────────────────
  app.get("/api/admin/fines", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: "X-Workspace-Slug header required" }); return; }
    const today = nzTodayIso();
    const rows = await loadFines(org.id, today);
    // Totals are computed from the same rows the page renders, so the number in
    // the chip and the number you get by adding up the list cannot disagree.
    res.json({ fines: rows, totals: summariseFines(rows, today), today });
  }));

  // ── One fine ───────────────────────────────────────────────────────────────
  app.get("/api/admin/fines/:id", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: "X-Workspace-Slug header required" }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ message: "Bad id" }); return; }
    const [row] = await loadFines(org.id, nzTodayIso(), id);
    if (!row) { res.status(404).json({ message: "Not found" }); return; }
    res.json({ fine: row, today: nzTodayIso() });
  }));

  // ── Create ─────────────────────────────────────────────────────────────────
  app.post("/api/admin/fines", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: "X-Workspace-Slug header required" }); return; }
    const patch = readBody(req.body, { partial: false });
    if (patch.paidOn && patch.waivedOn) throw new BadRequest("A fine cannot be both paid and waived");

    try {
      const [created] = await db.insert(fines).values({
        ...(patch as any),
        organizationId: org.id,
        createdBy: req.session.userId ?? null,
      }).returning();
      const [row] = await loadFines(org.id, nzTodayIso(), created.id);
      res.status(201).json({ fine: row });
    } catch (e: any) {
      // The unique index on the notice number doing its job. Say so plainly —
      // "duplicate key value violates constraint fines_org_reference_unq" is
      // not something a person can act on.
      if (String(e?.code) === "23505") {
        throw new BadRequest("A fine with that reference number is already logged");
      }
      throw e;
    }
  }));

  // ── Update ─────────────────────────────────────────────────────────────────
  app.patch("/api/admin/fines/:id", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: "X-Workspace-Slug header required" }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ message: "Bad id" }); return; }

    const [existing] = await db.select().from(fines)
      .where(and(eq(fines.id, id), eq(fines.organizationId, org.id)));
    if (!existing) { res.status(404).json({ message: "Not found" }); return; }

    const patch = readBody(req.body, { partial: true });
    // Check the RESULT, not the patch: clearing one of the two is how you
    // legitimately switch a fine from waived to paid.
    const paidOn = "paidOn" in patch ? patch.paidOn : existing.paidOn;
    const waivedOn = "waivedOn" in patch ? patch.waivedOn : existing.waivedOn;
    if (paidOn && waivedOn) throw new BadRequest("A fine cannot be both paid and waived — clear one first");

    try {
      await db.update(fines).set({ ...(patch as any), updatedAt: new Date() })
        .where(and(eq(fines.id, id), eq(fines.organizationId, org.id)));
    } catch (e: any) {
      if (String(e?.code) === "23505") {
        throw new BadRequest("A fine with that reference number is already logged");
      }
      throw e;
    }
    const [row] = await loadFines(org.id, nzTodayIso(), id);
    res.json({ fine: row });
  }));

  // ── Delete ─────────────────────────────────────────────────────────────────
  app.delete("/api/admin/fines/:id", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: "X-Workspace-Slug header required" }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ message: "Bad id" }); return; }

    const [existing] = await db.select().from(fines)
      .where(and(eq(fines.id, id), eq(fines.organizationId, org.id)));
    if (!existing) { res.status(404).json({ message: "Not found" }); return; }

    // 🔴 A logged fine is a financial record. A typo gets deleted; a fine that
    // has been paid, or that carries the notice or a receipt, gets WAIVED or
    // written off so the trail survives. Same reasoning as retiring a vehicle
    // rather than deleting it.
    if (existing.paidOn) {
      throw new BadRequest("This fine is marked paid — it can't be deleted. Clear the payment first if it was logged in error.");
    }
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(fineAttachments).where(eq(fineAttachments.fineId, id));
    if (count > 0) {
      throw new BadRequest(`This fine has ${count} attachment${count === 1 ? "" : "s"}. Delete the files first, or waive it instead of deleting it.`);
    }
    await db.delete(fines).where(and(eq(fines.id, id), eq(fines.organizationId, org.id)));
    res.json({ deleted: true });
  }));

  // ── Attachments: upload ────────────────────────────────────────────────────
  app.post(
    "/api/admin/fines/:id/attachments",
    ...gate,
    (req: Request, res: Response, next) =>
      upload.single("file")(req, res, (err: any) =>
        err
          ? res.status(400).json({
              message: err?.code === "LIMIT_FILE_SIZE"
                ? `That file is bigger than ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB`
                : "Upload failed",
            })
          : next(),
      ),
    handle(async (req, res) => {
      const org = await workspaceOrg(req);
      if (!org) { res.status(400).json({ message: "X-Workspace-Slug header required" }); return; }
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) { res.status(400).json({ message: "Bad id" }); return; }
      const [fine] = await db.select().from(fines)
        .where(and(eq(fines.id, id), eq(fines.organizationId, org.id)));
      if (!fine) { res.status(404).json({ message: "Not found" }); return; }

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) throw new BadRequest("No file was attached");
      const kind = str(req.body?.kind) ?? "other";
      if (!isFineAttachmentKind(kind)) throw new BadRequest("Unknown attachment kind");
      const filename = (str(req.body?.filename) ?? file.originalname ?? "file").slice(0, 250);
      const contentType = file.mimetype || "application/octet-stream";

      // Bytes go to the club's storage adapter — the same one Club Drive uses,
      // so these follow everything else to R2 when that happens, and are served
      // by short-lived signed URL rather than a public link. A fine notice
      // carries a plate, a person and an address; staff chat's public-URL
      // attachments are a known open issue and are not the pattern to copy.
      const put = await driveStorage().put(file.buffer, contentType, filename);

      const [created] = await db.insert(fineAttachments).values({
        organizationId: org.id,
        fineId: id,
        kind,
        filename,
        contentType,
        sizeBytes: put.sizeBytes,
        storageKey: put.storageKey,
        storageBackend: put.backend,
        checksum: put.checksum,
        uploadedBy: req.session.userId ?? null,
      }).returning();

      res.status(201).json({
        attachment: {
          id: created.id, kind: created.kind, filename: created.filename,
          contentType: created.contentType, sizeBytes: created.sizeBytes,
          uploadedAt: created.uploadedAt,
        },
      });
    }),
  );

  // ── Attachments: open / download ───────────────────────────────────────────
  app.get("/api/admin/fines/:id/attachments/:aid", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: "X-Workspace-Slug header required" }); return; }
    const id = Number(req.params.id);
    const aid = Number(req.params.aid);
    if (!Number.isInteger(id) || !Number.isInteger(aid)) { res.status(400).json({ message: "Bad id" }); return; }

    // Reachable only by (attachment AND fine AND org) — guessing an id cannot
    // cross a workspace, and 404 rather than 403 so an id is never confirmed.
    const [att] = await db.select().from(fineAttachments)
      .where(and(
        eq(fineAttachments.id, aid),
        eq(fineAttachments.fineId, id),
        eq(fineAttachments.organizationId, org.id),
      ));
    if (!att) { res.status(404).json({ message: "Not found" }); return; }

    const url = await driveStorage().signedUrl(att.storageKey, {
      download: req.query.download ? att.filename : undefined,
      expiresIn: 300,
    });
    res.redirect(url);
  }));

  // ── Attachments: delete ────────────────────────────────────────────────────
  app.delete("/api/admin/fines/:id/attachments/:aid", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: "X-Workspace-Slug header required" }); return; }
    const id = Number(req.params.id);
    const aid = Number(req.params.aid);
    if (!Number.isInteger(id) || !Number.isInteger(aid)) { res.status(400).json({ message: "Bad id" }); return; }

    const [att] = await db.select().from(fineAttachments)
      .where(and(
        eq(fineAttachments.id, aid),
        eq(fineAttachments.fineId, id),
        eq(fineAttachments.organizationId, org.id),
      ));
    if (!att) { res.status(404).json({ message: "Not found" }); return; }

    await db.delete(fineAttachments).where(eq(fineAttachments.id, aid));
    // The row is the record; a storage object nobody points at is just cost.
    // Removing bytes is best-effort — a storage hiccup must not leave the UI
    // claiming the file is still attached when the row has gone.
    try {
      await driveStorage().remove(att.storageKey);
    } catch (e) {
      console.error("[fines] attachment bytes not removed:", att.storageKey, e);
    }
    res.json({ deleted: true });
  }));

  // ── Who was holding this vehicle on that day? ──────────────────────────────
  // 🔴 A HINT, never an answer. The fleet assignment history knows who held a
  // vehicle on a date, and typing that name in by hand invites the wrong one.
  // But in New Zealand the registered owner is liable for an infringement
  // unless liability is formally transferred to the driver, so naming a driver
  // is an assertion a human makes — this endpoint offers, the person confirms,
  // and only then is anything stored.
  app.get("/api/admin/fines/driver-hint", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: "X-Workspace-Slug header required" }); return; }
    const vehicleId = idOrNull(req.query.vehicleId, "Vehicle");
    const on = dateOrNull(req.query.on, "Date");
    if (!vehicleId || !on) { res.json({ hint: null }); return; }

    const rows = await db.select({
      holderName: fleetAssignments.holderName,
      assignedOn: fleetAssignments.assignedOn,
      returnedOn: fleetAssignments.returnedOn,
    })
      .from(fleetAssignments)
      .where(and(eq(fleetAssignments.vehicleId, vehicleId), eq(fleetAssignments.organizationId, org.id)))
      .orderBy(desc(fleetAssignments.assignedOn));

    // ISO dates compare correctly as plain strings — zero-padded, big-endian —
    // so no Date is constructed anywhere in this comparison.
    const match = rows.find((r) => r.assignedOn <= on && (!r.returnedOn || r.returnedOn >= on));
    res.json({ hint: match ? { holderName: match.holderName, assignedOn: match.assignedOn, returnedOn: match.returnedOn } : null });
  }));
}
