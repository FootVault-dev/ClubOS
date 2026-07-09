// Render the Content Marketplace Creator Agreement to a local PDF for proofreading.
// Touches NO database and sends NO email — it imports the same `content` the seed
// script writes and runs it through the same typesetter the real signing flow uses,
// so what you read here is exactly what a signer would see.
//
// Usage: npx tsx script/proof-creator-marketplace.ts [outfile.pdf]

import { writeFileSync, readFileSync } from "node:fs";
import { renderNativePdf } from "../server/esign-native-pdf";
import { brand, content, form, settings } from "./seed-cic-creator-marketplace-template";

const OUT = process.argv[2] ?? "/tmp/creator-marketplace-agreement-PROOF.pdf";

// Illustrative values only — nothing here is a decided fee.
const values: Record<string, string> = {
  event_name: "the Christchurch International Cup, 5–16 July 2026",
  creator_fee: "$0.00 (TO BE SET)",
  share_pct: "30%",
  creator_name: "Max Comrie",
};

async function main() {
  let logoBytes: Uint8Array | null = null;
  try {
    logoBytes = new Uint8Array(readFileSync("client/public/logos/christchurch-international-cup.png"));
  } catch {
    console.warn("⚠️  logo not found — rendering without it");
  }

  const pdf = await renderNativePdf({
    brand,
    settings,
    content,
    values,
    formSpec: form as any,
    formData: null, // blank details schedule — the "what was sent" render
    parties: [
      { role: settings.primarySignerRole, name: null },
      { role: settings.counterSignerRole, name: null },
    ],
    logoBytes,
    envelopeId: null,
  });

  writeFileSync(OUT, pdf);
  console.log(`✅ Proof written to ${OUT} (${(pdf.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => { console.error("❌ Proof render failed:", err); process.exit(1); });
