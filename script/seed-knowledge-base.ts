/**
 * Seed the Knowledge Base with United Prints' specifications.
 *
 *   npx tsx --env-file=.env script/seed-knowledge-base.ts            # dry run
 *   npx tsx --env-file=.env script/seed-knowledge-base.ts --commit
 *
 * Idempotent on (brand, title): re-running updates the body of an article this
 * script owns and never touches one somebody has since rewritten by hand — an
 * edit by Dima is worth more than anything in here.
 *
 * 🔴 GROUNDING RULE. Every figure below traces to something real: the USC banner
 * catalog (Daniel's notes from a meeting with Dima), the researched NZ/AU trade
 * artwork guides, or the HP Latex 700W datasheet. Nothing is a "typical" value
 * invented to fill a table — a made-up print specification costs real money the
 * first time somebody prints to it. Where the source itself says "confirm",
 * the article says "confirm" too, in the text a staff member actually reads.
 *
 * 🔴 What is deliberately NOT here: prices, rates, and per-material maximum
 * sizes. Those live in the Materials tab, Dima edits them without a deploy, and
 * Rambo reads them live through the `print_materials` tool. Copying them into an
 * article would create a second source of truth that goes stale the first time
 * he changes a rate.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../server/db";
import { kbArticles } from "@shared/schema";

const COMMIT = process.argv.includes("--commit");
const DIMA_USER_ID = 7; // dima@cufc.co.nz — he keeps these accurate.

interface Seed {
  title: string;
  category: string;
  summary: string;
  keywords: string[];
  body: string;
}

const ARTICLES: Seed[] = [
  {
    title: "Maximum print size — the 1.6m roll rule",
    category: "Print specifications",
    summary: "We print up to 1.6m × 50m. The 1.6m limit applies to the shorter side of the artwork, not the side you call the width.",
    keywords: ["banner size", "max size", "roll width", "1.6m", "1600mm", "how big", "largest", "50m", "print limit"],
    body: `## The short answer

**1.6 m × 50 m.** One roll width by as much length as you need.

## The bit that catches people out

The 1.6 m limit applies to the **narrower side of the artwork**, not to whichever
side you happen to have labelled "width".

A **3000 × 800 mm** banner prints perfectly well — the 800 mm side runs across the
roll and the 3000 mm runs along its length. Length is effectively unlimited.

So the question is never "is my width under 1.6 m", it is **"is my shorter side
under 1.6 m"**.

## When something is wider than 1.6m on both sides

Two options:

- **Split it into panels** that are joined on site.
- **Weld it** — for PVC banner, panels are welded, never sewn or glued.

Both change the price and the lead time, so ask Dima before you promise a
customer a size.

## Files bigger than about 5.8m

Illustrator's canvas stops at 227 inches (**5.78 m**), so "just build it full
size" stops being possible past that. Anything longer — the 7.3 m entrance
columns, the 14 m net banners — has to be supplied as a **reduced-scale file with
every element as vector**, and the scale must be written in the filename and
stated when you send it.

## Where the per-product limits live

Each material has its own minimum and maximum size, and those are kept in
**ClubOS → United Prints → Materials**, where Dima edits them directly. Ask Rambo
"what are the size limits on corflute" and it reads that live rather than quoting
this page.

---
*Source: United Print house spec, from Daniel's meeting notes with Dima (mid-2025),
plus the HP Latex 700W datasheet (roll 457–1625 mm). ⚠️ The catalogue these came
from was a year old when it was captured — confirm with Dima before a final run.*`,
  },
  {
    title: "Artwork file formats — what to send United Prints",
    category: "File formats",
    summary: "PDF for final artwork, .AI if it still needs editing. CMYK, fonts outlined. JPG and PNG are not print files.",
    keywords: ["file format", "artwork", "pdf", "ai", "illustrator", "cmyk", "rgb", "what format", "send artwork", "fonts", "outline"],
    body: `## What to send

| Situation | Send this |
|---|---|
| Artwork is final, no more changes | **PDF** |
| The shop may need to edit it | **.AI** (Adobe Illustrator, editable) |

## Non-negotiables

- **CMYK**, not RGB. That is Dima's stated working space.
- **Outline all fonts** before export. A live font that isn't installed on the
  RIP machine silently substitutes, and you find out when the banner is printed.
- **Full size in the file** — or correct proportions with **every element as
  scalable vector**.
- Include the **bleed** the product needs (see the bleed article).

## What is not a print file

**JPG, PNG and GIF are not suitable for print.** They arrive flattened, usually
RGB, usually without enough resolution, and always without a bleed. Trade shops
in NZ charge a fee to fix them — one quotes $10 just to make a supplied file
print-ready. Send a PDF.

## Vector beats raster, every time

Vector artwork has no resolution ceiling: the same file prints crisp at 300 mm or
at 14 m. Logos, type and shapes should always be vector. Photographs obviously
can't be — those follow the resolution table in the viewing-distance article.

## Keep the RGB master

Deliver CMYK because that is what the shop asks for, but **archive your RGB
master**. The HP Latex press actually has a wider colour range than CMYK, and
once a file is converted that extra range is gone for good.

⚠️ **Worth one confirmation with Dima:** whether his RIP is set up to take RGB in
or CMYK in. HP's own guidance prefers RGB into the RIP; the shop's stated spec
says CMYK. Until that is settled, CMYK is what to send.

---
*Source: United Print house spec (Dima, via Daniel's meeting notes) + fetched NZ/AU
trade artwork guides (CMYKhub, BillboardsNZ, WS Print, PDQ Print).*`,
  },
  {
    title: "Resolution and text size by viewing distance",
    category: "Design specs",
    summary: "300 dpi close, 150 mid-range, 75 long range — plus the minimum letter height so a sign can actually be read from where people stand.",
    keywords: ["dpi", "ppi", "resolution", "300dpi", "150dpi", "75dpi", "text size", "font size", "readable", "viewing distance", "how sharp"],
    body: `## Dima's shorthand

**300 close · 150 mid-range · 75 long range.**

That is the house rule and it is right for almost every job.

## The full table

| Viewing distance | Target PPI | Bare minimum PPI | Minimum letter height |
|---|---|---|---|
| 0.5–1 m | 300 | 180 | 10 mm |
| 2 m | 150 | 90 | 17 mm |
| 3 m | 100–150 | 60 | 25 mm |
| 5 m | 75–100 | 35 | 42 mm |
| 10 m | 45–75 | 18 | 84 mm |
| 15 m+ | 30 | 12 | 130 mm+ |

The "target" column is what to design to. The "bare minimum" column is the point
below which it visibly falls apart — treat it as a warning line, not a plan.

## The press is never the problem

The HP Latex 700W prints up to 1200 × 1200 dpi. **Viewing distance and the
material are what limit sharpness**, not the machine. A mesh banner's open weave
eats fine detail long before the printer does.

## Letter height, the quick version

Minimum readable letter height in centimetres ≈ **viewing distance in metres ×
0.84**. So a sign read from 10 m needs letters about 8.4 cm tall as an absolute
minimum — use **1.5 to 2 times that** for anything you want read comfortably,
from a moving car, or by someone who isn't looking for it.

## Vector has no ceiling

None of this applies to vector artwork, which stays sharp at any size. It only
constrains photographs and other raster images.

---
*Source: Signageworks NZ distance bands (the "target" column), CMYKhub's steeper
table (the "minimum" column), HP Latex 700W datasheet. The letter-height constant
comes from a screen-signage guide — a good working proxy, not print-verified.*`,
  },
  {
    title: "Bleed, safe areas and finishing by product",
    category: "Design specs",
    summary: "How much bleed each product needs, and the pull-up banner trap that costs people the bottom of their design.",
    keywords: ["bleed", "safe area", "margin", "trim", "eyelets", "hems", "pull up", "roller banner", "corflute", "mesh", "finishing"],
    body: `## Bleed by product

| Product | Bleed |
|---|---|
| PVC banner | 5–10 mm (our own RIP needs none if there is no trim) |
| Mesh banner | 30 mm |
| Pull-up / roller banner | 3 mm |
| Corflute | 3 mm + crop marks |
| ACM panel | 3–10 mm |
| Fabric / SEG backdrop | 5 mm (10 mm if double-sided) |
| Teardrop / feather flag | Use the supplier's own die-line template |

## 🔴 The pull-up banner trap

A standard pull-up is **850 × 2000 mm** — but you should **build the canvas
850 × 2100 mm**. The bottom 100–150 mm rolls into the cassette and is never
visible once it is stood up.

**Put nothing important in the bottom 150 mm.** Logos and phone numbers placed
there disappear, and the first anyone knows about it is at the event.

## Teardrop and feather flags

Never work these out from dimensions. The pole sleeve construction means the
printed shape is not the shape you see — **always use the supplier's die-line
template**.

## Finishing notes worth knowing

- **PVC banners:** welded hems, never sewn or glued. Brass eyelets — spacing is
  either 300–500 mm or 1 m depending on the supplier, so **confirm with Dima**.
  Reinforced corners and webbing on the big ones.
- **Mesh:** hemmed and eyeletted. Spacing again varies by supplier — confirm.
  Wind slits mostly don't help, despite being asked for constantly.
- **Corflute:** eyelets, stake holes and die-cuts. **No sharp corners over 90°** —
  they risk back-cutting. #8 wire through the eyelets is a normal NZ fixing.
- **ACM:** stud or standoff mounted. 3 mm is standard, 4 mm for freestanding or
  windy sites, 6 mm structural.

---
*Source: fetched NZ/AU trade artwork guides (CMYKhub, Falcon, Flagseller,
Meshdirect, Promo-X, BillboardsNZ). ⚠️ Eyelet spacing genuinely differs between
suppliers — the disagreement is real, not an error in this page.*`,
  },
  {
    title: "Blacks, colour and ink limits for large format",
    category: "Design specs",
    summary: "Small text is 100% K only. Big solid black areas need a rich black, or they print grey.",
    keywords: ["black", "rich black", "cmyk", "ink limit", "colour", "color", "registration", "100k", "grey", "pantone", "pms"],
    body: `## Two rules, and which one applies depends on the element

**Text → 100% K only.** Nothing else. Small type built from four plates blurs
wherever the registration is a fraction out, and at small sizes that is the
difference between crisp and fuzzy.

**Large solid fills → rich black, C20 M20 Y20 K100.** Pure K across a big area
reads as dark grey rather than black. It looks fine on screen and disappointing
on a 4 m banner.

Get these the wrong way round and you get blurry text on a grey background.

## Ink limit

Around **270% total ink** on the latex RIP. Push past it and the ink stops
drying properly.

## Deliver flat CMYK

Every NZ and AU trade guide we checked says the same: **flat CMYK — no RGB, no
Pantone/PMS, no LAB** in the delivered file.

Notably, **none of them names an ICC profile**. Don't volunteer one to a shop
that hasn't asked for it.

## Colour matching expectations

A Pantone colour converted to CMYK will not be an exact match, and a brand colour
will look slightly different on PVC than on mesh or corflute — different
materials absorb ink differently. If an exact colour matters to a customer, say
so up front and get a proof printed on the actual material.

---
*Source: BillboardsNZ + CMYKhub trade specs, house findings from the food-truck
wrap research.*`,
  },
  {
    title: "USC banner placements and their sizes",
    category: "Placement & sizing",
    summary: "Every advertising placement at United Sports Centre and the size of banner it takes.",
    keywords: ["placement", "usc", "united sports centre", "perimeter", "pitch", "banner size", "behind goal", "entrance", "columns", "car park", "net banner", "adspace"],
    body: `## The placements

| Placement | Visible size | Notes |
|---|---|---|
| Entrance vertical columns | **1.6 × 7.3 m** visible (**1.6 × 7.5 m** printable) | 20 cm fixing allowance top and bottom. One currently held by CIC 7's, one by Mini Football Leagues |
| S1 & S2 pitch perimeter | **84 × 400 cm** | The standard full-pitch perimeter banner |
| Mini pitches perimeter — inside outline | **82 × 400 cm** | |
| Mini pitches perimeter — outside outline | **82 × 400 cm** | |
| Mini pitches — behind goals | **82 × 490 cm** | Currently FootVault |
| Vertical behind-goal banners | **120 × 460 cm** | 8 positions |
| Net banners between columns | **150 × 1400 cm** | Size still to be confirmed |
| Car park vertical banner | **90 × 540 cm** visible | |

## They all fit the roll

Every placement above has a shorter side of 1.6 m or less, so all of them print
in one piece with no welding. The long dimension runs along the roll.

## The two that need a reduced-scale file

The **entrance columns (7.3 m)** and the **net banners (14 m)** are both past
Illustrator's 5.78 m canvas limit. They can only be supplied as reduced-scale
files with everything as vector, and the scale must be labelled in the filename
and stated on delivery.

## ⚠️ Confirm before you print

These dimensions come from Daniel's notes of a meeting with Dima in mid-2025 and
were already a year old when they were written down here. They are the best
record on file and they are the right menu to design against — but **measure or
confirm with Dima before a final print run.**

## Selling these placements

The commercial side of these positions — rates, availability, booking — lives in
the USC AdSpace marketplace, not here. This page is about what size to print.

---
*Source: Daniel's notes from a meeting with Dima, United Print manager (~mid-2025),
captured 2026-07-10.*`,
  },
];

async function main() {
  console.log(`\n📚 Knowledge Base seed — United Prints specifications`);
  console.log(`   Mode: ${COMMIT ? "COMMIT" : "DRY RUN (pass --commit to write)"}\n`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const a of ARTICLES) {
    const [existing] = await db
      .select()
      .from(kbArticles)
      .where(and(eq(kbArticles.brand, "prints"), eq(kbArticles.title, a.title)));

    if (existing) {
      // If a human has edited it since we seeded it, leave it alone. Their
      // version is the club's real knowledge; ours is a starting point.
      const humanEdited = existing.updatedBy != null && existing.updatedBy !== DIMA_USER_ID;
      if (humanEdited) {
        console.log(`   ⏭  "${a.title}" — edited by a person since seeding, left alone`);
        skipped++;
        continue;
      }
      console.log(`   ↻  "${a.title}" — updating`);
      if (COMMIT) {
        await db
          .update(kbArticles)
          .set({
            summary: a.summary,
            body: a.body,
            category: a.category,
            keywords: a.keywords,
            updatedAt: new Date(),
          })
          .where(eq(kbArticles.id, existing.id));
      }
      updated++;
    } else {
      console.log(`   ✚  "${a.title}" — creating`);
      if (COMMIT) {
        await db.insert(kbArticles).values({
          brand: "prints",
          category: a.category,
          title: a.title,
          summary: a.summary,
          body: a.body,
          keywords: a.keywords,
          status: "published",
          ownerUserId: DIMA_USER_ID,
          createdBy: DIMA_USER_ID,
          updatedBy: DIMA_USER_ID,
          publishedAt: new Date(),
          // Deliberately NOT marked verified: nobody has confirmed these facts
          // since they were written down, and the whole point of that field is
          // that only a person can set it. Dima taps "Still accurate" and it
          // becomes true.
        });
      }
      created++;
    }
  }

  console.log(
    `\n   ${created} created · ${updated} updated · ${skipped} left alone${COMMIT ? "" : "  (nothing written — dry run)"}\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
