// ─────────────────────────────────────────────────────────────────────────────
// Club Drive — the storage adapter.
//
// Everything above this file addresses a stored object by an OPAQUE key and
// never parses it. That is the whole point: the club's files currently sit in
// the Supabase bucket, and the moment an R2 bucket exists they can sit there
// instead, without a single change to routes, search, the UI or the importer.
//
// 🔴 Why R2 is the intended destination, written down so the reasoning survives:
// this project has now been taken down TWICE by egress, not by storage cost —
// the ClubOS Supabase project was 402'd on `exceed_egress_quota` (shop images,
// chat attachments and hiring auditions all dark for weeks), and Cloudflare
// Stream sat over quota. R2 charges nothing for egress, ever. Storage is the
// cheap part; serving is what kept breaking.
//
// To switch: implement `R2Backend` below (S3-compatible PUT/GET with SigV4, or
// add @aws-sdk/client-s3), set DRIVE_STORAGE_BACKEND=r2 plus the R2_* env, and
// migrate existing rows by copying bytes and updating storage_backend. Rows
// already record which backend holds them, so the two can coexist during a
// migration and nothing has to move in one go.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";

export interface PutResult {
  storageKey: string;
  backend: string;
  sizeBytes: number;
  checksum: string;
}

export interface DriveStorageBackend {
  readonly name: string;
  put(buffer: Buffer, contentType: string, filename: string): Promise<PutResult>;
  /** A short-lived URL the browser can fetch directly — keeps big files out of the app's RAM. */
  signedUrl(storageKey: string, opts?: { download?: string; expiresIn?: number }): Promise<string>;
  get(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "clubos-uploads";

/** Keys are `drive/<uuid>.<ext>` — flat, never derived from the file's name. */
function makeKey(filename: string): string {
  const ext = (filename.split(".").pop() ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 10).toLowerCase();
  return `drive/${randomUUID()}${ext ? "." + ext : ""}`;
}

class SupabaseBackend implements DriveStorageBackend {
  readonly name = "supabase";
  private client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  async put(buffer: Buffer, contentType: string, filename: string): Promise<PutResult> {
    const storageKey = makeKey(filename);
    const { error } = await this.client.storage.from(BUCKET).upload(storageKey, buffer, {
      contentType,
      // Private bucket + signed URLs, so a long cache is safe and keeps repeat
      // opens off our egress.
      cacheControl: "private, max-age=3600",
      upsert: false,
    });
    if (error) throw new Error(`Drive upload failed: ${error.message}`);
    return {
      storageKey,
      backend: this.name,
      sizeBytes: buffer.length,
      checksum: createHash("sha256").update(buffer).digest("hex"),
    };
  }

  async signedUrl(storageKey: string, opts: { download?: string; expiresIn?: number } = {}): Promise<string> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .createSignedUrl(storageKey, opts.expiresIn ?? 300, opts.download ? { download: opts.download } : undefined);
    if (error || !data?.signedUrl) throw new Error(`Drive signed URL failed: ${error?.message ?? "no url"}`);
    return data.signedUrl;
  }

  async get(storageKey: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(BUCKET).download(storageKey);
    if (error || !data) throw new Error(`Drive download failed: ${error?.message ?? "no data"}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async remove(storageKey: string): Promise<void> {
    // Only ever called for a genuine purge, never by trashing. Trash is a
    // database state; the bytes stay until someone deliberately destroys them.
    const { error } = await this.client.storage.from(BUCKET).remove([storageKey]);
    if (error) throw new Error(`Drive remove failed: ${error.message}`);
  }
}

let backend: DriveStorageBackend | null = null;

export function driveStorage(): DriveStorageBackend {
  if (backend) return backend;
  const want = (process.env.DRIVE_STORAGE_BACKEND ?? "supabase").toLowerCase();
  if (want === "r2") {
    // Deliberately a hard failure rather than a silent fall back to Supabase:
    // if someone sets this expecting R2, quietly writing the club's files to
    // the quota'd project instead is the worst possible outcome.
    throw new Error(
      "DRIVE_STORAGE_BACKEND=r2 is not implemented yet. Implement R2Backend in server/drive-storage.ts " +
      "(S3-compatible, needs R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET), or unset the variable.",
    );
  }
  backend = new SupabaseBackend();
  return backend;
}

export function driveChecksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
