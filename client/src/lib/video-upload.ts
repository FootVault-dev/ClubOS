/* Upload a recorded/selected video to Cloudflare Stream.
 *
 * The server mints the upload session (our API token never reaches the
 * browser) and decides the transport: a basic direct-upload POST for files
 * under ~190MB, or a resumable tus session above that (Cloudflare's basic URL
 * hard-caps at 200MB). The tus client below is deliberately minimal —
 * sequential 50MB PATCHes with offset re-sync on failure — which is all
 * Cloudflare's tus endpoint needs; no dependency required.
 */
import { apiRequest } from "@/lib/queryClient";

export interface UploadSession {
  id: number;
  token: string;
  uid: string;
  kind: "basic" | "tus";
  uploadURL: string;
}

export class StorageFullError extends Error {
  constructor() {
    super(
      "The video storage account is full. Buy more Cloudflare Stream minutes (or delete old videos) and try again.",
    );
  }
}

export async function createUploadSession(opts: {
  title: string;
  sizeBytes: number;
  source: "recording" | "upload";
}): Promise<UploadSession> {
  const res = await apiRequest("POST", "/api/admin/videos/uploads", opts).catch((e: Error) => {
    if (/storage_full|507/.test(e.message)) throw new StorageFullError();
    throw e;
  });
  return res.json();
}

/** Basic (<200MB) upload: multipart POST with browser progress events. */
function basicUpload(uploadURL: string, blob: Blob, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadURL);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — check your connection and try again"));
    const form = new FormData();
    form.append("file", blob, "video");
    xhr.send(form);
  });
}

const TUS_CHUNK = 50 * 1024 * 1024; // Cloudflare recommends ~50MB chunks (min 5MB)

async function tusOffset(uploadURL: string): Promise<number> {
  const res = await fetch(uploadURL, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } });
  const off = Number(res.headers.get("upload-offset"));
  if (!res.ok || !Number.isFinite(off)) throw new Error("Could not resume the upload session");
  return off;
}

/** Minimal tus 1.0.0 client: sequential PATCHes, offset re-sync + retry. */
async function tusUpload(uploadURL: string, blob: Blob, onProgress: (fraction: number) => void): Promise<void> {
  let offset = 0;
  let failures = 0;
  while (offset < blob.size) {
    const chunk = blob.slice(offset, Math.min(offset + TUS_CHUNK, blob.size));
    try {
      const res = await fetch(uploadURL, {
        method: "PATCH",
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(offset),
          "Content-Type": "application/offset+octet-stream",
        },
        body: chunk,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = Number(res.headers.get("upload-offset"));
      offset = Number.isFinite(next) && next > offset ? next : offset + chunk.size;
      failures = 0;
      onProgress(offset / blob.size);
    } catch (err) {
      failures += 1;
      if (failures > 5) throw new Error("Upload kept failing — check your connection and try again");
      await new Promise((r) => setTimeout(r, 1500 * failures));
      offset = await tusOffset(uploadURL).catch(() => offset);
    }
  }
}

/** Full pipeline: mint session → push bytes → tell the server we're done.
 *  Returns the video row id for navigation. */
export async function uploadVideo(opts: {
  blob: Blob;
  title: string;
  source: "recording" | "upload";
  durationSeconds?: number;
  onProgress: (fraction: number) => void;
}): Promise<{ id: number; token: string }> {
  const session = await createUploadSession({
    title: opts.title,
    sizeBytes: opts.blob.size,
    source: opts.source,
  });
  if (session.kind === "tus") await tusUpload(session.uploadURL, opts.blob, opts.onProgress);
  else await basicUpload(session.uploadURL, opts.blob, opts.onProgress);
  await apiRequest("POST", `/api/admin/videos/${session.id}/uploaded`, {
    durationSeconds: opts.durationSeconds,
  });
  return { id: session.id, token: session.token };
}

export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "—";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
