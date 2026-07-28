// Offline queue for counter sales (D25).
//
// The shop's connectivity is unreliable and a customer is standing at the
// desk. Blocking the sale until the network comes back is the wrong trade —
// so a sale that can't reach the server is written to localStorage and posted
// when it can.
//
// The whole thing rests on ONE property: the idempotency key is minted HERE,
// on the client, at the moment of the sale, and stored with the payload. Every
// replay carries the same key, so the server's existing idempotency check
// (wh_movements.idempotency_key is uniquely indexed) turns a duplicate post
// into a no-op that returns the original movement. Without that, a flaky
// connection sells the same shirt twice — the response can be lost after the
// server has already committed, and the client cannot tell that case apart
// from a request that never arrived.
//
// Deliberately localStorage and not IndexedDB: a queued sale is a few hundred
// bytes, must survive a tab crash and a phone locking, and must be readable
// synchronously when the page boots. A queue that needs an async handshake to
// tell you it isn't empty is a queue people stop trusting.

const STORAGE_KEY = "wh_pending_sales_v1";

export interface PendingSale {
  /** Minted once, replayed forever. This is the safety property. */
  idempotencyKey: string;
  itemId: number;
  itemSku: string;
  locationId: number;
  locationCode: string;
  qty: number;
  note?: string;
  /** For the operator's own sake — "queued at 14:32" is what makes a pending
   *  row legible when they come back to it. */
  queuedAt: string;
  /** Bumped on every failed attempt so a permanently-bad row can be shown as
   *  needing attention rather than retrying silently forever. */
  attempts: number;
  lastError?: string;
}

function read(): PendingSale[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt queue must not brick the scan station. Losing an unsent sale
    // is bad; refusing to open the till is worse.
    return [];
  }
}

function write(rows: PendingSale[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* storage full or blocked — nothing useful to do here */
  }
}

export function pendingSales(): PendingSale[] {
  return read();
}

export function pendingCount(): number {
  return read().length;
}

/** A key that is unique per sale without needing the server or a UUID
 *  library: the item, the till, the moment, plus randomness for the case where
 *  two tills post the same item in the same millisecond. */
export function mintSaleKey(itemId: number, locationId: number): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `sale-${itemId}-${locationId}-${Date.now()}-${rand}`;
}

export function enqueueSale(sale: Omit<PendingSale, "queuedAt" | "attempts">): void {
  const rows = read();
  // Never queue the same key twice — a double-tap while offline must not
  // become two rows that both post later.
  if (rows.some((r) => r.idempotencyKey === sale.idempotencyKey)) return;
  rows.push({ ...sale, queuedAt: new Date().toISOString(), attempts: 0 });
  write(rows);
}

export function removeSale(idempotencyKey: string): void {
  write(read().filter((r) => r.idempotencyKey !== idempotencyKey));
}

export interface FlushResult {
  posted: number;
  /** Already recorded server-side — a replay that found its own earlier row.
   *  Counted separately so the UI can say "already recorded" rather than
   *  claiming to have sold something a second time. */
  replayed: number;
  failed: number;
  remaining: number;
}

/**
 * Tries to post every queued sale, oldest first.
 *
 * A row is removed when the server accepts it OR when the server rejects it as
 * permanently invalid (a 4xx that is not a timeout/conflict) — retrying a sale
 * the server will never accept just blocks the queue behind it forever. The
 * operator is told, so a genuinely lost sale is re-entered by a human rather
 * than silently dropped.
 *
 * `post` is injected so this module never imports the app's fetch wrapper and
 * stays unit-testable.
 */
export async function flushSales(
  post: (body: Record<string, unknown>) => Promise<{ ok: boolean; status: number; replayed?: boolean; message?: string }>,
): Promise<FlushResult> {
  const rows = read();
  if (rows.length === 0) return { posted: 0, replayed: 0, failed: 0, remaining: 0 };

  let posted = 0;
  let replayed = 0;
  let failed = 0;
  const keep: PendingSale[] = [];

  for (const row of rows) {
    try {
      const res = await post({
        itemId: row.itemId,
        locationId: row.locationId,
        qty: row.qty,
        note: row.note,
        idempotencyKey: row.idempotencyKey,
      });

      if (res.ok) {
        if (res.replayed) replayed++;
        else posted++;
        continue;
      }

      // 4xx that isn't a conflict means the server will never accept this
      // payload (bad location, item gone, stock refused). Keeping it would
      // wedge everything behind it.
      if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 408 && res.status !== 429) {
        failed++;
        continue;
      }

      keep.push({ ...row, attempts: row.attempts + 1, lastError: res.message });
    } catch (e: any) {
      // Network still down — keep it and try again next time.
      keep.push({ ...row, attempts: row.attempts + 1, lastError: e?.message });
    }
  }

  write(keep);
  return { posted, replayed, failed, remaining: keep.length };
}
