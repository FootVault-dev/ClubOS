# Deep Research Synthesis: Warehouse Management System
**Date:** 2026-07-13 | **Agents run:** 6 topic + critic + synthesis | **Platforms covered:** tier-1 WMS (Manhattan, Blue Yonder, Körber/Infios, SAP EWM, Oracle WMS Cloud) · SMB inventory/WMS (Cin7 Core, Unleashed, Odoo, ShipHero, Sortly, Katana, inFlow, Zoho, Fishbowl, Logiwa) · open-source ledger schemas (Odoo, ERPNext, InvenTree, Medusa) + hyperscale event-sourcing (Walmart, Salesforce) · Shopify Admin GraphQL API · browser scanning stack (caniuse/MDN/Chromium, ZXing-C++ WASM) · operational SOP / loss-prevention evidence (CSUDH stores manual, NRF NRSS, DeHoratius & Raman, Hollinger & Clark) | **Time period:** evergreen doctrine + 2024–2026 platform facts

---

## The Short Version

Plain English for a non-technical owner. Confidence labels: [HIGH] we know this well, [MEDIUM] good evidence with caveats, [LOW] a judgement call we should sanity-check.

- **The core idea is simple: the warehouse becomes a ledger, like a bank account. [HIGH]** Nothing changes the stock number except a recorded, named "movement" (received, put away, picked, shipped, adjusted, loaned). You never type a new stock number over the old one — you post a movement, and the stock number is calculated from the movements. This one rule is what ends "the system says we have it and we don't."

- **The real number you show for sale is calculated, never stored. [HIGH]** "Sellable" = what's physically on hand minus what's already promised to paid orders. We never keep a separate editable "available" number that can drift — we work it out every time it's asked for. This is the single most important build rule, and it's also the one place two of the research reports slipped up, so it's called out below.

- **Print your own labels as 2D codes (QR), not old-style stripe barcodes. [HIGH]** iPhones scan QR codes through the browser far more reliably than 1D stripe barcodes (Apple doesn't give web pages the camera focus control that 1D needs). Because United Prints literally prints its own labels, we simply choose QR and delete the worst phone-scanning problem before it exists.

- **Phone-camera scanning day one works — but we must test it on a real iPhone before we promise it. [MEDIUM]** The scanning engine (free, open-source, runs in the browser) is the right pick, but the one iPhone speed number we found is from a slightly different library. We measure on a real iPhone during the build, not after.

- **We do NOT need to pay for barcodes (GS1) for internal use. [HIGH]** Our own numbering on our own labels is free and correct. Paid GS1 barcodes only matter for selling through outside retailers like a supermarket or Amazon.

- **The WMS is the boss; Shopify just displays what we tell it. [HIGH]** Shopify itself documents exactly this "source of truth" pattern. We push our real sellable number out to the two Shopify stores (SIU, CUFC); Shopify never pushes a number back that we trust — if someone hand-edits stock in Shopify, we detect it and overwrite it.

- **Our own MFL/CIC checkouts can never oversell, by design. [HIGH]** Because those carts live in the same database as the warehouse, the sale subtracts stock in the same locked step that takes the order — there's no gap for two people to buy the last shirt. Shopify (being outside) gets the fast-but-slightly-delayed treatment, which is fine at a few orders a day.

- **A safety "buffer" isn't needed at our volume. [MEDIUM]** Big high-traffic sellers hold a few units back to cover sync lag. At a few orders a day with near-instant updates, a buffer mostly just hides real stock and costs sales. Default is zero, with a per-line switch if one scarce item ever proves it needs one.

- **Four brands, one room = a brand tag on each item, not four systems. [HIGH]** One warehouse, one WMS. Each item/bin is tagged with its owning brand so MFL stock can't be sold against CIC's channel. We build it segregated (safer, and easy to relax later if two brands share a truly identical blank item).

- **Counting little and often beats one big annual stocktake, and the counter must not see the expected number. [HIGH]** Count the valuable/fast-moving merch often, the rest occasionally, "blind" (screen hides the expected quantity so the person records what's actually there). A count never overwrites stock — it posts an adjustment movement with a reason and the counter's name.

- **The biggest wins are people-and-process, not software. [HIGH]** A locked room only named operators enter, every movement scanned to a person, everyone else requests stock and it's picked for them, and each brand is charged for what it draws. The evidence is blunt: honour systems work until one dishonest person, and just knowing "my name is on every scan" stops casual taking more cheaply than any punishment.

- **Loaned training gear is the same ledger, plus a due date. [HIGH]** A coach checks kit out against their name with a due date and a signed liability line; overdue/lost/damaged charges replacement cost; return means a staff member inspects and grades it. Automated reminders before the due date do most of the work.

---

## The Design Decisions (resolved)

Every major build decision this research settles. Each carries the decision, a confidence label, the backing reports, and any critic caveat. These are written to be lifted directly by the architecture-plan author.

### 1. Ledger architecture — append-only movements + derived stock + a reconciled cache
**Decision:** A two-layer core. (a) `inv_movement` — an **append-only** ledger; every physical change is one immutable signed-delta row (never `UPDATE`/`DELETE`; corrections are compensating rows). (b) `inv_stock` — a **cache** keyed `(item_id, location_id)` holding `on_hand` and `reserved`, maintained **in the same transaction** as each movement insert. `on_hand` is the ledger's `SUM(delta)`; the cache exists only for query speed and must be provably rebuildable. A **nightly reconcile job** asserts `inv_stock.on_hand == SUM(inv_movement.delta)` per `(item, location)`, alerts on drift, and heals the cache from the ledger. This replaces today's single mutable `shop_variants.stock` integer.
**Confidence:** [HIGH]. **Backing:** 04 (read from ERPNext `Stock Ledger Entry`+`Bin`, Odoo `stock.move`+`stock.quant`, InvenTree `StockItem`+`StockItemTracking` source code), 02 (Odoo double-entry model, primary/open-source), 01 (no-undocumented-movement primitive), critic §4 four-way convergence. **Caveat:** Medusa proves the reservation half but omits the ledger — that omission is exactly the "how did we get here?" gap we must not copy.

### 2. `available` is DERIVED, never stored — and the atomic guard sits on the stored column (resolves critic C1/X2)
**Decision:** `available = on_hand − reserved` (minus an optional per-channel buffer, default 0) is **computed at read time and never stored**. The race-safe write is an atomic conditional update of a **stored** column inside one transaction:
`INSERT … ON CONFLICT (item_id, location_id) DO UPDATE SET on_hand = inv_stock.on_hand + :delta` — and for `allow_negative = false` items, guard `WHERE inv_stock.on_hand + :delta >= 0` (0 rows affected ⇒ app raises "insufficient stock"). Report 05's native-cart snippet `UPDATE … SET available = available − :n WHERE available >= :n` **must be rewritten** — it treats `available` as a stored decrementable column, which reintroduces a second mutable source of truth that drifts against `on_hand`: the precise oversell bug the project exists to kill.
**Confidence:** [HIGH]. **Backing:** 04 (explicit, with the Postgres Read-Committed lost-update proof — a read-modify-write only *lowers* corruption probability), matches ClubOS house doctrine ("derived over stored", housing/vehicles precedent). **Caveat (critic C1):** this is the single highest-blast-radius correctness rule; state it explicitly so no builder copies 05's SQL.

### 3. Reservations are first-class (resolves X8 — one native-order lifecycle)
**Decision:** `inv_reservation` rows hold stock for anything promised-but-not-yet-shipped. Creating a reservation increments `inv_stock.reserved` in the same transaction; fulfilling it decrements `reserved` and posts a `pick`/`dispatch` movement; releasing (cancel) decrements `reserved`. A **partial unique index** enforces one active reservation per order line: `CREATE UNIQUE INDEX ON inv_reservation (ref_type, ref_id, item_id) WHERE status = 'active'`. **Unified native-order lifecycle:** a native MFL/CIC checkout, in its order transaction, (i) atomically decrements `on_hand` if it ships instantly, OR (ii) posts the movement **and** a hard reservation if there's any gap between payment and dispatch — either way stock is held at the instant of payment. Soft/checkout-hold reservations are optional and only worth building if genuine same-second contention on scarce merch appears; the hard reservation on payment success is the must-have.
**Confidence:** [HIGH]. **Backing:** 04 (`inv_reservation` design), 05 (native cart decrement), Medusa `ReservationItem`, Dynamics 365 soft/hard, Walmart ATS = OnHand − Reservations − Holds. **Caveat (X8):** decide the one native-order lifecycle up front — don't leave "movement vs reservation" ambiguous per code path.

### 4. Movement type + reason-code + disposition taxonomy (don't invent one)
**Decision:** `movement_type` (enum, validated in `shared/` app code, **no DB CHECK constraint** — a stale CHECK is how the MFL checkout 500'd): `receipt, putaway, pick, dispatch, transfer, adjustment, count, return, consume, assemble, loan_out, loan_return`. `reason_code` (nullable, for adjustments/returns): `damage, shrinkage, theft, count_variance, write_off, sample, expiry, found, store_use, donation, return_to_supplier`. `disposition` (nullable): `on_hand | unavailable` — damaged/quarantine stock moves to **unavailable**, it does not vanish (mirrors Oracle Retail SIM's ATS/TRBL buckets). A reason code is not just a label; it decides which bucket the stock lands in.
**Confidence:** [HIGH]. **Backing:** 04 (InvenTree `StockHistoryCode` enum + Oracle Retail SIM reason-code table with dispositions, both primary), 01 (SAP EWM exception codes force capture). **Caveat:** keep the taxonomy in one `shared/` module; validate the set there, never with a database CHECK.

### 5. Negative-stock policy — per-item flag, default block
**Decision:** `allow_negative` boolean per item, **default false**. Candidate `true` items: bulk print-shop raw materials where receiving paperwork lags the physical consume. Serial/batch-tracked items (we have none active) are never allowed negative. The reconcile job flags any negative for follow-up.
**Confidence:** [HIGH] that both stances are legitimate. **Backing:** 04 (Unleashed "block" orthodoxy vs ERPNext's shipped "Allow Negative Stock" toggle; ERPNext issue #29636 wants per-item granularity — the mature position). **Caveat:** genuine policy fork, so make it configurable rather than picking one globally.

### 6. Brand ownership keying — segregated `(item, brand_owner, location)` (resolves critic C3/X3)
**Decision:** Key stock and ledger rows by `(item, brand_owner, location)` — **owner-segregated by default**. One physical warehouse, one WMS, brand is a namespace tag on the stock (the ClubOS "brand is a namespace, not an owner" precedent; Dynamics 365 "owner inventory dimension"; 3PL multi-client architecture). An MFL cart / MFL Shopify store draws only MFL-owned availability, never CIC's, even for an identical physical blank. **Escape hatch:** pool a genuinely fungible item (with brand-allocation at pick time) only where the humans who know the stock confirm it's fungible.
**Confidence:** [HIGH]. **Backing:** 05 + 02 (segregated). **Resolved against 04**, which preferred a shared pool by default. **Reasoning (critic C3):** this is a schema-keying decision — a migration, not a config change, if wrong. Segregated is the **relaxable superset**: pooling a fungible item later is cheap; splitting a shared pool after the fact is not. It also matches physical reality (most merch is brand-printed and non-fungible). Flagged as a conscious choice.

### 7. Location scheme — shallow, human-speakable, named special zones
**Decision:** `ZONE-AISLE-BAY-LEVEL-POSITION` (e.g. `A-12-04-02-B`); two-digit numeric aisle/bay/level (three at 100+), letters for zone + position, level counted from the floor up (`01` = ground). **Start aisles at 10 and/or number even-only, leaving gaps** so future inserts need no renumbering. But keep it **shallow and speakable** — start with 5–10 locations; if the team can't say a location out loud and everyone knows where it is, it's too complex. Bake named special zones into the address space: **RECEIVING, DISPATCH/STAGING, PACK** (fast movers in a forward-pick slot next to the pack bench), **QUARANTINE/HOLD** (system-unpickable by rule, not by memory). Virtual/accounting locations too (`supplier`, `customer`, `scrap`, `transit`) so every movement is a transfer between two locations (Odoo's trick — receipts/dispatches/adjustments/loans all become the same primitive).
**Confidence:** [HIGH] on the scheme; [MEDIUM-HIGH] on quarantine-as-a-zone (reasoned from zoning guidance). **Backing:** 03 (ID Label / Supply Velocity / ShipHero convergent), 01 (5–10 speakable locations — InventoryQuick, single-source but on-point), 04 (virtual locations). **Caveat (critic U1):** the "keep it tiny" prescription leans on a vendor selling a small tool — hold it as a bias-aware heuristic, but it aligns with the internal-controls literature.

### 8. Barcode symbology + SKU scheme + manufacturer aliasing
**Decision:**
- **Symbology per label type:** our own item labels → **QR** (default), **DataMatrix** for tiny labels (vinyl-roll ends, small accessories). Bin/location labels → **QR** with payload `LOC:<address>` + a large human-readable line. Carton/tote LPN labels → **QR** carrying an internal LPN + big human-readable number (**no SSCC** — single site, no cross-company handoff). Manufacturer 1D EANs (KELME etc.) → scan as-is via alias.
- **SKU scheme:** hybrid, mostly-stable — `<BRAND>-<CAT>-<STYLE>-<COLOUR>-<SIZE>` (e.g. `MFL-KIT-HOME-BLK-M`), uppercase, hyphen-delimited, ≤20 chars, **no ambiguous glyphs** (`0/O`, `I/l`). Encode **only durable attributes** — never price/supplier/location/season ("smart codes become wrong codes"). **Two-tier data model:** product/style (parent) → variant/SKU (child); a variant is the unit that owns a barcode and a bin.
- **Manufacturer-barcode aliasing:** a `barcode_aliases` table (**many barcodes → one variant**) with an optional `pack_qty` multiplier (scan one case code = receive 12 units). Register the manufacturer EAN as an alias; **relabel with our own QR only** when no manufacturer code exists, its 1D read is flaky on iPhone, or one manufacturer code doesn't distinguish variants we need. SKU is the canonical join key — validated at write time (no silent leading-zero loss, no blank SKU on a sellable item).
**Confidence:** [HIGH]. **Backing:** 03 (GS1 scope, symbology mechanism, SKU hygiene, aliasing — all triangulated), 02 (SKU-is-the-join-key, from Unleashed/Cin7/Odoo sync-failure catalogue).

### 9. Label printing — in-house standard
**Decision:** Thermal-transfer at **203 DPI** for durable rack/bin labels (**300 DPI** for small/dense 2D or fine text); direct-thermal acceptable for short-lived pick/pack labels. Enforce quiet zones (QR ≥4 modules; 1D ≥10× X-dim and ≥0.25" if any 1D is used) and a **human-readable line** on every label. Consistent bin-label placement/height, laminated or magnetic for durability.
**Confidence:** [HIGH]. **Backing:** 03 (McAuley/Acctivate/idprt/barcodefaq). United Prints already runs the print hardware, so this is in-house at zero marginal cost.

### 10. Scanning stack — WASM baseline + native fast-path + the iPhone measurement gate (resolves critic's iOS gate)
**Decision:** One uniform scan path: the **`barcode-detector` ponyfill (ZXing-C++ compiled to WebAssembly)** as the universal baseline across iOS Safari, Windows/Linux Chrome, Firefox and Android — with the **`.wasm` self-hosted from the ClubOS origin** (CSP-clean, offline-capable). Opportunistic native fast-path: at session start call `getSupportedFormats()`; if the array is **non-empty** (Android / macOS / ChromeOS), use native `BarcodeDetector` for that session to save CPU/battery. **Feature-detect on the format array, never on `'BarcodeDetector' in window`** — native is absent/off on iOS Safari (present since WebKit 17.0 but disabled-by-default), Chrome on Windows/Linux (empty array), and Firefox (never). Camera UX: continuous decode, duplicate-debounce, **audio beep as the primary confirm** (`navigator.vibrate` haptic is an Android-only bonus — iOS doesn't expose it), torch button **gated on `getCapabilities().torch`** (Android only, hidden on iOS), well-lit scan stations (so we never depend on iOS torch/focus), and directed **scan → validate → auto-advance** loops with a distinct error buzz on mismatch. Dedicated hardware scanners later integrate via **onScan.js** (inter-keystroke timing + prefix/suffix, no input focus needed) routing into the *same* "code scanned" pipeline. Commercial SDK (Scandit/Dynamsoft) is a **contingency only** if we later must scan many damaged/tiny/1D manufacturer codes at speed — not needed for v1 because we print large, clean, high-ECC 2D labels ourselves.
**🔴 MANDATORY GATE:** measure **ZXing-C++ WASM decode latency on a real modern iPhone via Safari before rollout.** The one reassuring datum ("~150 ms / a couple of frames") is from **ZBar**, a *different* library, single-source. Do not promise phone-camera responsiveness until our exact stack is measured on real hardware.
**Confidence:** [HIGH] on the stack and browser-support facts (caniuse/MDN/Chromium primary); [MEDIUM] on iOS WASM performance (single datum, wrong library). **Backing:** 03. **Caveat (critic decision-risk #3):** the core phone-camera-first decision fails on operators' actual phones if this gate is skipped; de-risked by printing our own 2D labels.

### 11. Shopify sync design — GraphQL master push, webhook + reconcile, echo suppression (resolves critic C4)
**Decision:** WMS is the source of truth; **GraphQL-first** (REST Admin API is legacy since 1 Oct 2024; do not base the master push on it).
- **Write path:** `inventorySetQuantities` (absolute SET — Shopify's own docs route a source-of-truth caller here, vs `inventoryAdjustQuantities` for participants), `name: "available"`, value = ledger-derived available for that `(item, brand_owner)` on the store's location, `ignoreCompareQuantity: true` (we're master — but keeping compare-and-set on is a cheap guard against a rogue admin edit), `referenceDocumentUri` = our movement ref, and the **`@idempotent(key:…)` directive** on every call. Push is **per-store** (each store has its own inventory-item IDs and location IDs — keep a per-store mapping table).
- **Push trigger:** fire on **every ledger movement** for the affected `(item, store)`, debounced ~2–5 s to coalesce bursts ("push-on-movement", not batch). Nightly full push as a belt-and-braces reset.
- **Inbound webhooks:** `orders/create` (demand → ledger decrement), `orders/cancelled` + `refunds/create` (restock → increment), `inventory_levels/update` (**drift monitor only**). Every handler: verify HMAC → dedupe on `X-Shopify-Webhook-Id` → drop any event older than the last applied for that item+location by `X-Shopify-Triggered-At` → apply idempotently → respond 200 within 5 s (heavy work off-thread). Delivery is at-least-once and unordered by Shopify's own admission.
- **Echo suppression:** after each push, record `(inventory_item_id, location_id, available, ~timestamp)` we wrote; when the matching `inventory_levels/update` echo arrives, **skip it**. Only an *unmatched* update is external drift (a manual Shopify Admin edit) → re-assert the WMS value + log who/when.
- **Reconcile poll:** every 5–10 min (hourly would be safe for us), read each store's `available` per mapped SKU, diff against ledger-authoritative available, write a **drift report**. **Auto-heal** by re-pushing when the WMS is confidently right; **alert a human** when the discrepancy implies the *physical* count is wrong (Shopify shows a sale/fulfilment the ledger never saw, or available would go negative) — auto-healing a real physical discrepancy would hide theft/miscount. The poll also covers the known empty-`inventory_levels/update`-payload bug.
**🔴 VERIFY-AT-BUILD (critic C4):** the `@idempotent` directive is **optional as of 2026-01 and REQUIRED as of 2026-04** — a push without a key **fails** on current versions. Re-confirm live: (a) the `@idempotent` requirement date + syntax, (b) current leaky-bucket size (sources split 50 vs 100 pts/s restore — irrelevant at our volume but confirm), (c) whether REST inventory endpoints still function (no announced sunset ≠ safe). Do not hardcode any of these from the report.
**Confidence:** [HIGH] on the architecture and API facts (shopify.dev primary); date-sensitivity flagged. **Backing:** 05.

### 12. Native-cart integration — retire `shop_variants.stock` as truth
**Decision:** The native MFL/CIC checkout does a **synchronous, conditional, same-transaction** decrement of the master ledger (`on_hand` stored column guarded `>= n`; rows-affected = 0 ⇒ out of stock, reject the sale). Because the carts share Postgres with the WMS, this is a hard race-free guarantee no async Shopify-style push can match — **native-channel oversell becomes structurally impossible**. Retire the separate `shop_variants.stock` counter and re-point native checkout at the one master ledger. The resulting movement then triggers the async Shopify push like any other. **Hybrid rule:** internal channels decrement synchronously in-DB; external channels (Shopify) are served asynchronously (event → push, webhook → ledger, reconcile). The single ledger absorbs a native-cart decrement and a Shopify `orders/create` identically — both are just movements.
**Confidence:** [HIGH]. **Backing:** 05. Fixes the current `shop_variants.stock` integer directly.

### 13. Receiving / putaway / pick / pack / dispatch — the steal-vs-skip workflow set
**Decision (STEAL as core):**
- **Receiving = verify-before-you-sign gate.** Receive only against an **expected inbound** (a lightweight "expected receipt", not full EDI ASN); **blind receiving** (operator counts and enters what they see; the system knows the expected count and hides it — kills confirmation bias); mismatches/damage → **QUARANTINE**, never into good stock; scan-to-create-on-hand against the named receiver. Receiving is the highest-leverage control (dock errors cascade downstream — carry the *rank order*, not synkrato's single-source "40–60%" figure).
- **Putaway = scan-to-bin**, nothing left unputaway overnight (staging limbo is the #1 "system says we have it, can't find it" cause). Record where it went; skip the velocity-slotting optimisation engine (overkill at hundreds of SKUs; directed putaway "amplifies bad master data").
- **Picking = discrete/single-order as the default** (right for low volume, easiest to audit), **cluster** as the one scale-up worth pre-planning (multi-order into separate bins on one cart, no sortation). **SKIP zone and wave** (explicitly fail for small/linear/unpredictable operations). Pick-by-list + **scan-to-verify**; short-picks are **logged, never silently substituted**.
- **Pack/dispatch = scan-to-verify gate** — the last line of defence before an error leaves the building; especially load-bearing because a wrong pick on a Shopify order becomes a customer problem. Nothing crosses the counter without a scanned document (requisition/issue or loan checkout) attached to a named person.
- **Returns = inspect → grade (A resalable / B repackage / C damaged / D scrap) → disposition,** quarantine-first, reason-coded; **separate physical disposition from accounting credit** (a warehouse operator shouldn't manage when a customer gets credited); never auto-restock damaged goods.
- **Exception handling = force-capture.** An anomaly (short pick, damage, misplaced) must be *recorded* with a required reason, never silently absorbed. Implement as a few required exception reasons, not SAP's config framework.
**Decision (SKIP):** wave/zone picking, task interleaving, slotting-optimisation engine, labor-management module, yard management, voice/pick-to-light, full EDI ASN — all pure scale machinery the tier-1 vendors themselves sell as optional plug-ins.
**Confidence:** [HIGH] on the doctrine and rank-order; specific vendor percentages are directional only. **Backing:** 01 (steal-vs-skip table), 06 (SOP control points), 02 (ShipHero floor UX — batch modes, forced location-scan-before-continue, fulfilment-status push-back, "never bidirectional").

### 14. Counting doctrine — blind, ABC, CLUB-SCALE cadence + thresholds (resolves critic C5/X4/X5)
**Decision:** Continuous **cycle counting**, **blind** (counter sees location + item only, never expected quantity), **ABC-weighted**, count-by-location (scan a bin → assigned to count it → bin locks during the count → variances write to an append-only log tagged with the operator). A count **never edits `inv_stock` directly** — on approval each line posts an `inv_movement` of type `count`/`adjustment` with `reason_code = 'count_variance'`. Counter and approver must differ (segregation of duties). Over-threshold variance triggers an **independent recount by a different person** before any adjustment posts; investigate open transactions before adjusting.
**Our CLUB-SCALE defaults (judgement, NOT citation — flagged):**
- **Cadence:** A-class (top ~20% of SKUs / ~80% of value — sellable merch, high-value event stock) **monthly**; B-class **quarterly**; C-class (low-value consumables) **twice a year**, plus one fuller count annually for attestation. Target IRA **97–99% on active SKUs**.
- **Variance thresholds (percentage-led, low dollar floors):** e.g. **>10% or >$100** ⇒ mandatory independent recount + manager investigation before posting; **≤10% and ≤$100** ⇒ operator may post the reason-coded adjustment. Tune from live data.
**Confidence:** [HIGH] on the doctrine (blind, ABC, segregation, count-posts-a-movement); [LOW] on the specific numbers (our judgement). **Backing:** 04 (koronapos figures), 01 (ISM/RFSmart cadence), 06 (CPCON tiers, CSUDH three-independent-count practice), critic C5. **Caveat (critic C5):** both source reports' thresholds are single-source and enterprise-scaled — a $5,000 (or even $500) investigation trigger at a club stockroom would **never fire**, silently defeating loss detection. Do not copy either source; use these club-scale defaults and tune.

### 15. Requisitions + chargeback — friction where it's worth it, pull where it isn't
**Decision:** Non-warehouse staff **cannot self-serve** valuable/accountable stock; they submit a requisition (item, qty, needed-by, pickup point, **cost-centre/brand to charge**), and the warehouse **picks it FOR them and stages it** for collection by the named requester. Fulfilment runs in **windows** (e.g. morning + afternoon), not walk-up interruptions, with a **defined emergency-draw exception** (named on-call operator, or a logged self-draw reconciled next window) so the first inconvenient moment doesn't blow up the system. **Chargeback:** each brand/cost-centre is billed monthly for what it draws (the internal transfer price) — the brand that draws it, pays for it. For **high-frequency low-value consumables** (print-shop raw materials, fasteners, tape, packaging) use a **two-bin/kanban pull** (empty front bin = the reorder signal), NOT a requisition per draw — requisition friction on cheap items just gets bypassed.
**Confidence:** [HIGH]. **Backing:** 06 (CSUDH stores manual — a real operation at United Prints' scale; two-bin from Owens & Minor/Radboud), 01 (stores-requisition as an accounting control: sequential numbering, segregation of duties, authorization). **Caveat:** chargeback is arguably a more powerful deterrent than the lock for the honest-but-careless majority.

### 16. Equipment loan model — same ledger + due date + liability
**Decision:** A loan is `loan_out`/`loan_return` movements to/from a `customer`-like virtual location. Checkout is **against a named person** (scan the asset + the borrower), with a **due date** and a **signed loan agreement** (liability terms). Two modes: **per-session draw** (same-day return — balls/bibs/cones) vs **seasonal bulk issue** (a coach signs out a term kit bag). **Automated reminders** at pickup, before due, and overdue (part-time coaches forget). On return a staff member **inspects and condition-grades**; loss/damage/non-return **charges replacement cost** to the person/cost-centre; the checkout stays "open/overdue" until reconciled.
**Confidence:** [HIGH] on the model; [MEDIUM] that the ledger-primitive mapping is a *named* pattern (it's the Odoo generalisation, sound but the synthesis's own construction — none of the four systems models club-equipment-loan natively). **Backing:** 06 (Cheqroom/EZOffice + university AV/athletics policies), 04 (ledger mapping).

### 17. Access-control dose — proportionate, not theatre
**Decision:** Locked room + a short named-operator list (already decided — validated). **Make access attributable:** per-person PIN/badge with a time-stamped log if budget allows, else a key-custody sign-out log — the **log, not the lock, is the deterrent.** One visible camera at counter/door. **Do NOT impose a true two-person rule on the whole room** (a vault/nuclear control, disproportionate with 1–3 operators) — reserve the concept for a single high-value sub-cabinet (cash/gift cards) if one exists. Signage: "Warehouse — named operators only. All stock is scanned in and out" (a low-cost "watching-eyes" deterrent).
**Confidence:** [HIGH] on the doctrine; specific vendor break-in percentages are single-source/directional. **Backing:** 06 (Overton/NIST/ProDataKey; Hollinger & Clark deterrence-by-perceived-certainty; DeHoratius & Raman 65%-records-wrong).

### 18. SOP adoption playbook — make it stick from day one
**Decision:** Co-author the SOPs with the print-shop manager + the 1–2 operators who run the room (don't hand them a document). Laminate a **one-page SOP at each point of use** (receiving counter, pick bench, loan desk, door). **Leadership models it first** — Daniel and the manager scan their own draws, no exceptions (the moment a manager takes something un-scanned, the system is dead). Run a **~2-week grace period + a buddy sign-off**, then hold the line. In a 1–3-person team you can't fully segregate duties, so use **compensating controls**: manager reviews the movement/variance report weekly, occasional surprise counts, duty rotation, and at minimum separate the person who books stock out from the person who counts it (CSUDH's dedicated debit clerk).
**Confidence:** [HIGH]. **Backing:** 06 (docsie/SphereWMS adoption literature; SafePaaS/Bonadio compensating controls; CSUDH real practice).

---

## High-Confidence Findings

These are the four-way (or primary-source) agreements the build can lean on hard.

- **The ledger + derived-cache split is universal and primary-sourced.** ERPNext (`Stock Ledger Entry`+`Bin`), Odoo (`stock.move`+`stock.quant`), InvenTree (`StockItem`+`StockItemTracking`) all implement it in code; only Medusa collapses to levels-only and pays with no audit trail. Reports 01/02/04 reach it independently. [HIGH]
- **On-hand is a signed running total maintained transactionally; available subtracts reservations; corrections are compensating entries, never edits.** ERPNext literally blocks cancelling an individual SLE. [HIGH]
- **Blind receiving and blind counting are standard** and kill confirmation bias — the counter/receiver must not see the expected number. Triangulated across 01/02/04/06 (Infoplus, ShipHero, Odoo, CPCON, CSUDH). [HIGH]
- **WMS-as-master pushing one-directional quantity to Shopify is exactly Shopify's documented pattern** (`inventorySetQuantities` carries the verbatim "only use if you are the source of truth" instruction). Never bidirectional quantity sync (ShipHero: "systems overwrite in a loop, ship to wrong location"). [HIGH]
- **Shopify auto-decrements `available` at order creation** (units move `available → committed`), so the pre-push window is safe in the direction that matters — Shopify won't re-sell a just-sold unit on its own. At a few orders/day the oversell race barely exists. [HIGH]
- **Webhook delivery is at-least-once, unordered, best-effort — reconcile.** Shopify itself: "your app shouldn't rely on receiving data from Shopify webhooks." Dedupe on `X-Shopify-Webhook-Id`, order on `X-Shopify-Triggered-At`, respond <5 s, 8 retries over ~4 h. A reconciliation poll is not optional. [HIGH]
- **iPhones scan 2D far more reliably than 1D through the browser**, because iOS Safari denies web pages the camera autofocus/torch control 1D needs — verified across html5-qrcode issues #423/#145/#915. We print our own labels, so we choose QR/DataMatrix and delete the failure mode. [HIGH]
- **Native `BarcodeDetector` is absent/off on the exact platforms operators use** (iOS Safari disabled-by-default since 17.0; Chrome Windows/Linux empty array; Firefox never) — the ZXing-WASM ponyfill baseline is mandatory, native is only an opportunistic fast-path. Verified against caniuse/MDN/Chromium. [HIGH]
- **No GS1 membership needed for internal use.** Our own Code 128 / QR / DataMatrix with an internal numbering scheme is correct and free; GS1 only for external retail/marketplace channels. [HIGH]
- **Inventory records are wrong by default** — DeHoratius & Raman: 65% of ~370,000 records inaccurate, average gap 35% of on-hand, at a firm that already ran a computer system. The "we don't actually have it" problem is endemic, not a United Prints failing; the fix is scan-discipline + cycle counting, not just anti-theft. [HIGH — peer-reviewed]
- **Deterrence works through perceived certainty of detection, not severity** (Hollinger & Clark). Named-scan-per-movement raises perceived certainty of identification to ~100%, which shuts down casual taking more cheaply than any punishment. [HIGH — peer-reviewed]
- **Honour systems collapse the moment one dishonest person appears** — United Prints' exact lived experience. Self-service is acceptable only for immaterial consumables (two-bin), never for reconcilable stock. [HIGH on the principle]
- **A single item lives in three units** (purchase/stock/consume — the vinyl-by-the-metre-bought-by-the-roll problem); resolve with a base UoM + purchase-conversion factor, recorded per movement. Kitting/BOM turns "complete this print job" into one consume-movement per component in its own UoM. [HIGH]

---

## Medium-Confidence Findings

- **Buffer 0 is right for us** — a defensible inference from our scale (few orders/day, single-digit-second push, Shopify auto-decrements at order time), not a cited standard. Vendors' per-channel buffer percentages (Amazon 10–15%, Shopify 5%) are high-velocity practice from the SEO corpus. [MEDIUM] — see Tensions X1.
- **The burst/flash-sale path needs only cheap mitigations at our volume** (debounce, idempotency, reconcile poll), not the heavy queue/buffer engineering ShipHero's flash-sale failure implies for high-velocity sellers. [MEDIUM]
- **Task interleaving / directed-putaway productivity gains (10–30%)** are vendor-marketing numbers, effectively single-origin, and irrelevant at a few operators walking one room. [MEDIUM — concept solid, numbers unverified]
- **iOS WASM decode performance** is reassuring but rests on one datum from a different library (ZBar, not ZXing) — must be measured on real hardware. [MEDIUM]
- **Two-bin kanban eliminates requisitions for cheap consumables** with reported "zero stockouts" — the "zero" is a vendor case study, treat as illustrative; the mechanism is sound. [MEDIUM-HIGH]
- **Detection comes mostly from tips + routine audit** (ACFE-lineage figures) — so the audit trail and count cadence are both deterrent and detection. [MEDIUM-HIGH]
- **The "over-buying is the main regret" heuristic** is directionally useful but structurally biased (sourced from vendors of smaller tools, no raw practitioner-forum corroboration). Hold as a bias-aware heuristic; sanity-check each "SKIP" against the convergent primitives before dropping a needed one. [MEDIUM] — see critic U1.

---

## Tensions & Contradictions (and how each was resolved)

| # | Tension | Resolution | Why |
|---|---|---|---|
| **C1/X2** | `available` derived vs stored; where the atomic guard sits | **`available` DERIVED (`on_hand − reserved`), never stored. Atomic conditional guard on the stored `on_hand`** (or `reserved` via a reservation row). Report 05's `UPDATE … SET available = available − n` is rewritten. | 04 is correct and matches house doctrine; 05's snippet was internally inconsistent with its own prose. Copying it reintroduces the exact oversell/drift bug the project exists to kill. Highest blast radius — stated explicitly. |
| **C2/X1** | Per-channel safety buffer vs buffer 0 | **Buffer 0 default; optional per-channel 1-unit reserve on flagged scarce lines** (an optional knob, not a formula term). | 04 + 05 win 2-to-1 and on the merits at our volume; 02's buffered formula is the high-velocity market pattern from the same SEO corpus as 05 (one data point, not two — echo chamber E1). |
| **C3/X3** | Brand ring-fencing: shared pool vs owner-segregated | **Segregated keying `(item, brand_owner, location)` by default; pool only where humans confirm fungible.** | It's a schema-keying decision (a migration if wrong). Segregated is the relaxable superset — pooling later is cheap, splitting a shared pool later is not. Matches ClubOS "brand is a namespace" precedent + physical reality (brand-printed merch is non-fungible). Resolved against 04's shared-default. |
| **C5/X4/X5** | Count cadence + variance thresholds (01 vs 04 vs 06, all single-source, enterprise-scaled) | **Treat every cited number as a representative starting point; set CLUB-SCALE defaults** — A monthly / B quarterly / C twice-yearly; variance >10% or >$100 ⇒ recount+investigate, else operator posts. Flagged as judgement, not citation. | Both source reports' thresholds are single-source and enterprise-scaled; a $5,000 (or $500) trigger at a club stockroom never fires, silently defeating loss detection. |
| **C4** | Shopify API facts are load-bearing and date-sensitive | **Carry a "verify live at build" banner; never hardcode.** `@idempotent` required 2026-04, bucket size unresolved, REST-inventory "no sunset" ≠ safe. Build GraphQL + idempotency key from day one. | This is exactly where a model's stale API knowledge bites; the `@idempotent` date alone can make every mutation fail. |
| **iOS scan** | ZXing-WASM the pick, but performance datum is soft | **ZXing-WASM ponyfill is the baseline; add a mandatory real-iPhone measurement gate before rollout.** | The one iOS speed number is from ZBar, a different library. De-risked by printing our own 2D labels (clean high-ECC codes are easy reads). |
| **X6** | Push `available` vs `on_hand` to Shopify | **Default `SET available`; note `on_hand` as the alternative** if we ever fulfil inside Shopify. | Setting `available` matches "Shopify is a downstream display we overwrite"; `on_hand` keeps Shopify's committed math coherent but complicates buffers. Minor. |
| **X8** | Sale as reservation-then-fulfil vs direct decrement | **Unify one native-order lifecycle:** native checkout posts a movement + (if any gap before dispatch) a hard reservation — both hold stock at payment. | 04 models paid-but-unshipped; 05 models instant native checkout. Decide the single lifecycle up front. |
| Event sourcing: essential vs overkill | **Take the append-only ledger table; skip the distributed-systems machinery** (no projectors, replay tooling, schema registries, separate read store). One ledger + one cache in Postgres, same transaction. | The critics attack the machinery, not the ledger; the middle ground (Outbox / explicit events in the same DB txn) is exactly ERPNext/Odoo. [HIGH this is the right read] |
| Negative stock: block vs allow | **Per-item flag, default block; allow for bulk print materials where paperwork lags.** Reconcile job flags negatives. | Genuine policy fork (Unleashed block vs ERPNext's shipped toggle); ERPNext users explicitly want per-item granularity. |
| "You don't need a WMS" vs "drift kills you" | **Both true; the deciding variable is whether movements are documented, not headcount.** United Prints already fails the spreadsheet test, so build the ledger + control primitives, skip the enterprise modules. | Nippon Express/BoxHero's "wait" camp doesn't apply; their *scope restraint* does. |

**Convergences worth banking (not contradictions):** ledger + derived cache (01/02/04); blind receiving + blind counting (01/02/04/06); inspect→grade→disposition + reason codes + quarantine on returns (01/04/06); WMS-as-master, one-directional WMS→Shopify, never bidirectional (02/05); phone-camera / 2D-first scanning (01/03); named-scan-per-movement accountability as the core control (01/06). These are the spine.

---

## What We Don't Know (gaps, negative rejections, verify-at-build)

**Verify live at build (do not hardcode from the reports):**
- **Shopify `@idempotent` requirement date (2026-04) + current directive syntax** — build-critical; a push without a key fails on current versions. [critic C4/Verification Queue]
- **Current GraphQL leaky-bucket size** (sources split 50 vs 100 pts/s restore, 1,000 vs 2,000 bucket) — non-blocking at our volume but self-flagged unresolved in 05.
- **Whether REST inventory endpoints (`inventory_levels.json`) still function / have gained a sunset date** — 05's "no sunset" is absence-of-evidence. Recommendation: don't use them anyway.
- **Exact Shopify `available → committed → on_hand` transition sequence** — reasoned from the committed note + on_hand identity, not found spelled out verbatim on one page.
- **ZXing-C++ WASM decode latency on a real modern iPhone via Safari** — measure our exact stack; the "~150 ms" datum is ZBar, single-source. [critic decision-risk #3]
- **Safari `BarcodeDetector` real behaviour if the flag is user-enabled** — not confirmed to primary depth; low impact (we don't rely on it).

**Single-source numbers to carry as direction only, not hard facts:**
- "40–60% of downstream errors originate at receiving" (synkrato, single source) — carry the rank-order (receiving > putaway > pick > pack), drop the number.
- "67% picking-error reduction", "99%+ accuracy with gates", "four-gate checklist", task-interleaving "10–30%" — vendor-glossary tier, directional.
- Count cadence + variance thresholds — every cited figure is single-source and enterprise-scaled; our club-scale defaults are judgement.
- Security-vendor stats (60% of break-ins 10pm–6am; "watching eyes ~35%"; honesty-box 94–99%) — directional, not relied on for any recommendation.

**Echo-chamber flag (critic E1):** the "hybrid webhook + reconciliation poll", "sub-5s standard", and "per-channel buffer" claims appear in **both** reports 02 and 05, which reads as two reports agreeing — but both trace to the **same 2–3 SEO blogs** (digitalapplied, nventory, techspawn). Count as **one** data point. The reconcile-poll half is independently blessed by shopify.dev, so it survives; the buffer half gains no independence from appearing twice (and is overridden at our scale).

**Independence downgrade (critic Verification Queue):** report 01 treats "Altavant 99→65-in-60-days" and "BoxHero average-retailer-65%" as two independent confirmations, but BoxHero's "65% of records" is suspiciously identical to DeHoratius & Raman's 2008 peer-reviewed 65%. If BoxHero restates that study, 01's "two independent sources" is an echo, not triangulation. Build impact low — the *direction* (records drift wrong by default) is robustly primary in 04/06.

**Negative rejections (deliberately NOT built):**
- **No full event-sourcing infrastructure** — one ledger + one cache table in Postgres is the correct weight.
- **No lot/batch/serial workflow** — nothing we stock is regulated or serial-worthy. Keep only a dormant nullable `lot`/`batch` field so it can switch on later for one item without a migration.
- **No per-movement FIFO/moving-average valuation engine** — a stored `unit_cost_cents` on receipt movements answers our valuation questions; add an engine only if accounting later demands COGS by layer.
- **No wave/zone picking, task interleaving, slotting engine, labor management, yard management, voice/pick-to-light, full EDI ASN** — pure scale machinery.
- **No true two-person rule on the whole room** — vault-grade, disproportionate for 1–3 operators.

**Tooling losses this session (practitioner voice missing — not filled with invention):** Supadata (YouTube/video) was rate-limited (HTTP 429) across all six reports; Reddit public `.json` 403-blocked; X-Search / Firecrawl down. So there is **no raw practitioner war-story / forum / video-demo layer** this session — the "what small ops regret skipping" and "real oversell war story" evidence rests on named implementation-consultant writing, vendor help-docs, peer-reviewed studies, and primary source code/API docs, not first-person forum voice. This is a genuine texture gap, honestly flagged, not gap-filled.

**Other honest gaps:** Zendesk help centres (Cin7/Unleashed/ShipHero/Sortly) 403 direct fetch, read via search extraction (direct-quote fidelity slightly softer). Walmart's idempotency/ordering internals undisclosed (moot for our single-DB build). No named pattern in the four systems for club-equipment loan (mapped onto the ledger primitive — synthesis's own construction, sound but uncited). Bemi.io contrarian event-sourcing article unreadable (substituted the CQRS/ES critique corpus).

---

## Key Sources (consolidated, ranked; echo-chamber cluster noted)

**Tier 1 — primary source code / official docs / standards body / peer-reviewed (highest weight):**
- **Odoo** — GitHub `addons/stock` (`stock_move_line.py`, `stock.rst`) + official docs. The crown-jewel double-entry move/quant model; the virtual-location trick. (02, 04)
- **ERPNext (Frappe)** — `Stock Ledger Entry` doctype source + DeepWiki + perpetual-inventory docs. Clearest ledger/cache split; immutability guards in code. (04)
- **InvenTree** — `status_codes.py` source (`StockHistoryCode`, `StockStatus` enums). Ready movement taxonomy + status vocabulary. (04)
- **shopify.dev** — mutation references (`inventorySetQuantities`/`AdjustQuantities`/`MoveQuantities`), manage-quantities-states, webhooks best-practices, usage/limits, REST legacy notice. Sole-sufficient authority for every API fact; cited 12+ times in 05. **Date-sensitive — re-verify.**
- **Oracle Retail SIM** — inventory-adjustments reason-code table with dispositions (ATS/TRBL/COR). Canonical reason-code axis. (04)
- **Oracle WMS Cloud** — 16-state LPN context list (primary for LPN-as-state-machine). (01)
- **SAP EWM** — Learning course (exception handling) + Handling Unit docs. Reference implementation of force-captured exceptions. (01)
- **caniuse + MDN + Chromium blink-dev** — `BarcodeDetector` support matrix + the "wraps an OS vision library, no plan to ship on Windows" mechanism. (03)
- **Sec-ant/barcode-detector (npm + GitHub)** — the ZXing-C++ WASM ponyfill we'd adopt. (03)
- **GS1 US / GS1 UK** — GTIN/GS1-128/SSCC scope (when GS1 is/isn't required). (03)
- **DeHoratius & Raman**, *Inventory Record Inaccuracy* (Management Science 54(4), 2008) — peer-reviewed 65%-records-wrong. (06)
- **Hollinger & Clark**, *Deterrence in the Workplace* (1983) — peer-reviewed certainty-beats-severity. (06)
- **CSU-Dominguez Hills Inventory Stores Manual (Feb 2024)** — a real operating manual at United Prints' scale; the single most transferable primary document for requisition/chargeback/count. (06)
- **NRF National Retail Security Survey 2023** — source-of-shrink split (external 36 / internal 29 / process 27). (06)
- **Microsoft Dynamics 365 SCM** — owner inventory dimension (multi-brand-in-one-warehouse pattern) + soft/hard reservations. (05, 04)
- **Walmart Global Tech (Medium)** — event-sourced availability, ATS = OnHand − Reservations − Holds. (04)
- **PostgreSQL docs + Vlad Mihalcea** — Read-Committed lost-update proof. (04)

**Tier 2 — vendor primary for "does it exist" (zero weight for "is it good"):**
- Cin7 Core (Available-Quantity + event-driven push contract; AUOM stocktake). ShipHero (mobile picking UX, cycle-count model, "never bidirectional", flash-sale escape hatch). Unleashed (the sync-failure catalogue). Medusa (reservation half, no ledger). Sortly/Katana/inFlow/Zoho/Fishbowl/Logiwa (feature/paywall map + anti-patterns). (02)
- html5-qrcode GitHub issues #423/#145/#915 (iOS 1D autofocus failure — practitioner ground truth). onScan.js (keyboard-wedge integration). (03)
- Cheqroom / EZOfficeInventory / gocodes + university AV/athletics policies (loan/return settled model). (06)

**Tier 3 — bias-flagged / echo-chamber cluster (pattern only, numbers discounted):**
- **🔴 The multichannel-sync SEO corpus — digitalapplied "2026 Decision Matrix", nventory, techspawn "2026 Operator's Playbook", xictron, fulfil, warpspeed** — used by **both** 02 and 05; classic dated-title content-marketing (signal 0–1). Count as **one** data point. Kept for the architecture pattern (which matches Shopify's own guidance); their numbers (buffer %, "20–30% oversell in minutes", "sub-5s") not promoted.
- Scandit/Dynamsoft benchmarks (two competing vendors — direction usable, magnitudes self-serving). InventoryQuick/Wisys/Cadre (small-tool vendors — the "over-buying regret" backbone, bias-aware). synkrato/Hyperbots/Oxmaint (vendor-glossary stats, directional). Overton Security (access-control principles good, percentages self-interested). koronapos/CPCON (single-source thresholds, enterprise-scaled).

---

## Recommended Next Steps (for the build)

**Lift directly into the architecture plan (settled, high-confidence):**
1. The **Postgres data model from report 04** — `inv_item` (add inventory columns to existing `shop_variants`/product identity, don't fork the catalogue), `inv_location` (physical + virtual), `inv_movement` (append-only ledger with `idempotency_key UNIQUE`, `CHECK (delta <> 0)`, no CHECK on the enum-ish text columns), `inv_stock` cache keyed `(item, brand_owner, location)`, `inv_reservation` (partial unique index on active), `inv_count_session`/`inv_count_line` (blind, segregated approval, posts a movement), `inv_bom`/`inv_bom_line` (print-job kitting). `available` computed, never stored. Nightly reconcile job.
2. **Brand-segregated keying `(item, brand_owner, location)`** with a documented fungible-pool escape hatch.
3. **Barcode aliasing** (`barcode_aliases`, many→one, optional `pack_qty`), the `<BRAND>-<CAT>-<STYLE>-<COLOUR>-<SIZE>` SKU scheme, two-tier product→variant model, the `ZONE-AISLE-BAY-LEVEL-POSITION` location scheme with gaps + named special zones, 2D (QR/DataMatrix) labels printed in-house at 203/300 DPI.
4. **The scanning stack** — ZXing-WASM ponyfill self-hosted from ClubOS origin, opportunistic native fast-path (feature-detect on the format array), one `useScanner()` abstraction covering camera + future keyboard-wedge.
5. **The Shopify sync design** — GraphQL `inventorySetQuantities` per-store master push with `@idempotent`, `orders/create`/`cancelled`/`refunds` inbound, `inventory_levels/update` as drift-monitor-only with echo suppression, 5–10 min reconcile poll (auto-heal when WMS is right, alert when physical count looks wrong).
6. **Native-cart integration** — retire `shop_variants.stock` as truth; synchronous conditional same-transaction decrement of the master ledger.
7. **The SOP set + control points from report 06** (receiving/putaway/pick/pack/dispatch/returns/count/requisition/loan skeletons), the requisition + monthly chargeback model, two-bin kanban for cheap consumables, the equipment-loan model, the proportionate access-control dose, and the SOP-adoption playbook.

**Must verify live before or during the build (do not proceed on the report's word):**
1. **🔴 Shopify `@idempotent` requirement + syntax** (required 2026-04) — build GraphQL + idempotency key from day one; a push without it fails.
2. **🔴 Measure ZXing-C++ WASM decode latency on a real modern iPhone via Safari** before promising phone-camera responsiveness.
3. Current GraphQL bucket size; whether REST inventory endpoints still function (don't use them regardless).
4. **Set club-scale count cadence + variance thresholds** (our defaults are judgement) and tune from live data — don't ship a threshold that never fires.
5. Confirm with the humans which items (if any) are genuinely fungible across brands (pool candidates) and which bulk print materials warrant `allow_negative = true`.

**Sequencing suggestion:** ledger + cache + reservations + native-cart cut-over (the correctness core) → scanning stack + labels + locations (the floor layer) → Shopify master push + reconcile (the external layer) → SOPs + access + requisition/chargeback + loan (the human layer, co-authored with the operators). The correctness core is the load-bearing 10% the autonomous-loop pattern stalls on — build it human-led.
