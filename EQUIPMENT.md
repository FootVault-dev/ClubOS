# Equipment Register — runbook

**United Sports Group workspace → Equipment** (`app.usg.co.nz/admin/equipment`).
Live 2026-08-18. Built from the meeting with Ryan and Travis that morning and
the whiteboard photographed at the end of it.

Who can see it: **Daniel** (super admin), **Ryan Edwards**, **Travis Graham**.
The tab is locked; those two were let in individually. Add the next person with
`script/grant-unlocked-tab.ts <email> equipment united-sports-group --commit`
— no deploy, no re-login.

---

## The idea in one line

One named person is responsible for one team's gear, they keep their own list,
and every term they say what they actually have.

That ordering is deliberate and comes straight from the meeting: *"we don't
want to do it by equipment, we want to do it by team"*, and *"it should be one
main person per team"*. Accountability is the product. The inventory — what the
club owns, so we can reorder and write grant applications — falls out of it.

---

## Running it

**1. Add the teams.** Equipment → **Add team**: team name, the person
responsible, their email. Nothing is seeded, because which teams exist and who
holds their gear is Travis's spreadsheet, not something to infer from a payment
list.

**2. Send them their link.** Open the team → **Copy** → send it. It opens their
equipment list on any phone with no login and no password. They build the list
themselves with **+ Add equipment** — that is the whiteboard's own wording and
the point of the whole design: *"it shouldn't be Travis inputting information."*

New gear arriving mid-year works the same way. Gear turns up, you message them,
they add it from the same link.

**3. Each term, open an audit.** Audits tab → **Open an audit** → pick the term
and a due date. Then **Chase everyone outstanding**, which emails everyone who
has not submitted, with their link.

**4. Watch the board.** Click a round to see every team: submitted, not yet,
overdue. Chase individuals. Once someone submits, you see what they counted
against what the register said — so a team that has quietly lost eight bibs
shows up as *eight short*, not as a feeling.

Nothing sends on a schedule. Reminders go when a human presses the button.

---

## Things worth knowing before you change it

**A blank is not a zero.** If somebody leaves a line uncounted it stores as
`null`, shows as `—`, and does not touch the register. It is not a shortfall.
Anyone half way down a form on their phone has not reported losing everything,
and the day this rule gets "simplified" is the day the tab starts accusing
coaches.

**The count boxes start empty on purpose.** Pre-filling them with what the
register already believes turns the audit into a rubber stamp — everyone taps
submit, every number confirms itself, and the club learns nothing.

**One active holder per team, enforced by Postgres.** Two people responsible is
nobody responsible. Retire the first to appoint a replacement; retiring keeps
their history and frees the team name.

**Nothing about status is stored.** Submitted / overdue / late / variance are
all computed from rows that either exist or do not (`shared/equipment.ts`). Edit
a due date and every badge is instantly right, because there was never a second
copy of the answer.

**`quantity_before` is frozen** the first time a line is counted in a round.
Submitting writes the counted numbers onto the items, so variance recomputed
later would read zero for everything, forever.

**Coaches do not get ClubOS logins, and that is a security decision.**
`canAccessTab` grants every tab in a workspace to an admin/manager membership,
and `users.role` defaults to `coach` — which is also what a member of the public
gets from signing up to a fan app. Giving twenty-five part-timers accounts so
they can count footballs would be the largest access change the club has ever
made, made sideways. They get a signed `eqh:` link instead, in the same shape
the referee portals already use, re-checked against the live row on every
request.

**Revoking is immediate.** Retire someone, or press **New link**, and their old
link stops working on the next tap — it does not wait for a token to expire.

---

## Verifying it still works

```
npx tsx --env-file=.env script/_verify-equipment-live.ts
```
24 checks against live rows and live production: the gate (Ryan and Travis in,
the other ten USG members out, and neither of them gained Budget or Housing),
plus the holder link exercised for real — a token reaching another team's items,
a retired holder's token, a rotated link, and the null-is-not-zero rule.

Both routes are in `script/preflight-deploy.ts`, so a later deploy from a branch
that lacks them will refuse to ship rather than silently delete the feature.

---

## Open, for a human

- **No teams are in it yet.** Travis was still filling in the team-and-
  coordinator list when the meeting ended.
- **Kit and uniform are deliberately excluded** — asked directly in the meeting,
  the answer was no. Uniform stock lives in the Warehouse.
- **The loss-threshold policy Ryan mentioned** — a team being responsible beyond
  a certain percentage of items — is *not* built. The register now produces the
  number that policy would need; what the threshold is, and what happens when a
  team crosses it, is his call.
- **Reminders are email only.** If chasing by email does not land, the natural
  next step is the staff app's push, not a louder email.
