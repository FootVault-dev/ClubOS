// Moves the United Prints FAQs out of the website's source and into ClubOS.
//
//   npx tsx --env-file=.env script/seed-print-faqs.ts [--commit]
//
// 🔴 Every question and answer below is VERBATIM from the live site — the seven
// from src/site.ts (FAQ.items, on the home and contact pages) and the five from
// src/components/livechat/chatConfig.ts (the chat widget). Nothing is rewritten,
// merged or "improved": whatever the site says today is what customers have been
// reading, and changing the wording is Dima's call, not a migration's.
//
// The two lists overlap in subject but not in text — the website answers are long
// and specific, the chat ones short. So they stay as separate rows with different
// surface flags rather than being deduplicated into one compromise answer.
//
// Idempotent on (brand_key, question): re-running updates the answer and flags
// but never duplicates, and never clobbers a question Dima has since added.

import "dotenv/config";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const ORG_ID = 8;
const BRAND = "unitedprints";

type Seed = { q: string; a: string; web: boolean; chat: boolean };

// ── From src/site.ts → FAQ.items (home + contact pages) ─────────────────────
const WEBSITE: Seed[] = [
  {
    q: "Can I get a quote quickly?",
    a: "Definitely. You’ll receive a clear, tailored quote within 3 hours, so you can plan your project without delays or uncertainty. Just let us know in your request if you need it urgently, and we’ll prioritise it.",
    web: true, chat: false,
  },
  {
    q: "How wide can you print?",
    a: "Our HP Latex 700W printer prints up to 1.6 meters wide, giving you seamless, high-quality visuals for banners, wall graphics, and more. Simply include your width requirements in your order request.",
    web: true, chat: true,   // the one question the quote form now enforces — worth having in chat too
  },
  {
    q: "Can you print in white?",
    a: "Yes! Our HP Latex 700 W printer can print white ink, giving you stunning results on transparent or coloured materials. This means logos, text, or designs pop exactly as you envision them—perfect for window graphics, decals, and overlays. Just let us know you need white when sending your request.",
    web: true, chat: false,
  },
  {
    q: "How eco-friendly is your printing?",
    a: "We use our HP Latex printer to create high-quality, long-lasting prints that are safe for indoor use. Water-based inks with extremely low VOC emissions and recyclable cartridges reduce waste and pollution — giving you professional results while keeping New Zealand cleaner.",
    web: true, chat: false,
  },
  {
    q: "How does my order support youth and local sport?",
    a: "As Christchurch United’s own print studio, every order you place directly funds youth football programmes. Printing banners, decals, uniform numbers, or supplying uniform kits helps train over 400 academy students, run mini-leagues for adult players, and support community events across Christchurch.",
    web: true, chat: false,
  },
  {
    q: "Can I order materials or uniforms for my club?",
    a: "Absolutely. We supply everything your club needs — from uniform kits and printed numbers to banners and decals. Multiple items for mini-leagues, academy teams, or adult squads can be ordered at once, saving time and effort.",
    web: true, chat: false,
  },
  {
    q: "Can I get printing materials for my own print shop?",
    a: "Yes. We provide high-quality materials for wide-format printing, banners, vinyl, and more. Whether you run a small studio or a larger print shop, ordering in bulk is simple, deadlines are met, and results are consistent.",
    web: true, chat: false,
  },
];

// ── From src/components/livechat/chatConfig.ts → faqs (the chat widget) ─────
const CHAT: Seed[] = [
  {
    q: "What can you print?",
    a: "Large-format banners, signage and posters, teamwear names and numbers, stickers, pull-up banners and more. Tell us your project and we'll quote it.",
    web: false, chat: true,
  },
  {
    q: "How do I get a quote?",
    a: "Send us the details — what you need, size, quantity and your deadline — and we'll come back with a price and turnaround.",
    web: false, chat: true,
  },
  {
    q: "What's your turnaround?",
    a: "It depends on the job, but many items turn around in just a few days. Share your deadline and we'll tell you what's possible.",
    web: false, chat: true,
  },
  {
    q: "Do you help with design or artwork?",
    a: "We can print your supplied artwork or help get your files print-ready. Ask us about your file and we'll guide you.",
    web: false, chat: true,
  },
  {
    q: "Where are you based?",
    a: "At the United Sports Centre in Christchurch. We print for clubs, businesses and events across the city.",
    web: false, chat: true,
  },
];

const ALL = [...WEBSITE, ...CHAT];

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

  const exists = await q(
    `select 1 from information_schema.tables where table_name = 'site_faqs'`,
  );
  if (!exists.length) {
    console.error("✗ site_faqs doesn't exist — apply migrations/2026-08-12_site_faqs.sql first.");
    await pool.end();
    process.exit(1);
  }

  const current = await q(`select id, question, answer, show_on_website, show_in_chat, display_order from site_faqs where brand_key = $1`, [BRAND]);
  const byQuestion = new Map(current.map((r: any) => [r.question, r]));

  console.log(`${COMMIT ? "APPLYING" : "DRY RUN"} — ${ALL.length} FAQs for ${BRAND} (org ${ORG_ID})`);
  console.log(`Already in ClubOS: ${current.length}\n`);

  let added = 0, updated = 0, same = 0;

  for (let i = 0; i < ALL.length; i++) {
    const seed = ALL[i];
    const order = (i + 1) * 10;
    const existing: any = byQuestion.get(seed.q);
    const surfaces = [seed.web && "website", seed.chat && "chat"].filter(Boolean).join(" + ");

    if (!existing) {
      console.log(`  + "${seed.q}"  →  ${surfaces}`);
      added++;
      if (COMMIT) {
        await q(
          `insert into site_faqs (organization_id, brand_key, question, answer, show_on_website, show_in_chat, is_active, display_order)
           values ($1,$2,$3,$4,$5,$6,true,$7)`,
          [ORG_ID, BRAND, seed.q, seed.a, seed.web, seed.chat, order],
        );
      }
    } else if (existing.answer !== seed.a || existing.show_on_website !== seed.web || existing.show_in_chat !== seed.chat) {
      console.log(`  ~ "${seed.q}"  →  ${surfaces} (answer/flags differ from the live site)`);
      updated++;
      if (COMMIT) {
        await q(
          `update site_faqs set answer=$2, show_on_website=$3, show_in_chat=$4, updated_at=now() where id=$1`,
          [existing.id, seed.a, seed.web, seed.chat],
        );
      }
    } else {
      same++;
    }
  }

  // Anything Dima has added himself is left completely alone.
  const extra = current.filter((r: any) => !ALL.some((s) => s.q === r.question));
  if (extra.length) {
    console.log(`\n  Left untouched (added in ClubOS, not from the site): ${extra.length}`);
    extra.forEach((r: any) => console.log(`    · "${r.question}"`));
  }

  console.log(`\n${added} to add · ${updated} to update · ${same} already correct`);

  if (COMMIT) {
    const after = await q(
      `select count(*)::int total,
              count(*) filter (where is_active and show_on_website)::int web,
              count(*) filter (where is_active and show_in_chat)::int chat
         from site_faqs where brand_key = $1`, [BRAND]);
    console.log(`\n✓ ${after[0].total} FAQs stored · ${after[0].web} on the website · ${after[0].chat} in the chat widget`);
  } else {
    console.log(`(dry run — re-run with --commit)`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
