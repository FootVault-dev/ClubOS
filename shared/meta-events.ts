// Deterministic Meta pixel/CAPI event ids (AttributionOS T15).
//
// The SAME event id MUST be produced by the browser pixel call and the server
// CAPI call for one purchase, so Meta deduplicates them (Meta matches on the
// tuple (event_name, event_id) inside its dedup window). NEVER add a timestamp
// or randomness here — that is exactly the bug this module removes.
//
// Ids are namespaced by the CONVERSION TABLE the row lives in, because a row id
// is only unique *within* its own table. `registrations` (MFL teams, holiday
// camps and class registrations all share this table) and `facilityBookings`
// (venue hire, keyed by booking-group) each have their own id space, so an
// un-namespaced `purchase_<id>` could collide across them and make Meta drop a
// genuine second purchase as a "duplicate". Keep the two builders distinct.
//
// NOTE (human task): whether two events actually collapse depends on Meta's
// dedup *window*, which is configured/observed in Events Manager — not here.
// This module only guarantees matching ids; window behaviour is verified live.

/**
 * Purchase event id for a `registrations`-table conversion (MFL team deposit,
 * holiday camp booking, class registration). Used by BOTH the browser Purchase
 * pixel and the server CAPI Purchase for the same registration.
 */
export function purchaseEventId(registrationId: number | string): string {
  return `purchase_${registrationId}`;
}

/**
 * Purchase event id for a venue hire, keyed by the booking GROUP (one payment,
 * many `facilityBookings` rows). Namespaced with a `venue` segment so it can
 * never collide with a `purchase_<registrationId>` id from the shared
 * registrations table.
 */
export function venuePurchaseEventId(bookingGroupId: string | number): string {
  return `purchase_venue_${bookingGroupId}`;
}
