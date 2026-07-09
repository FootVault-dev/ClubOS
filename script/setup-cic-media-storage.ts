// Setup script: creates the two CIC Media Library Supabase Storage buckets if
// they don't exist, confirms credentials work, and round-trip tests each.
//
// - clubos-media           PRIVATE  — original photo/video uploads
// - clubos-media-previews  PUBLIC   — watermarked previews + thumbs
//
// Usage: npx tsx script/setup-cic-media-storage.ts
//
// NOT run as part of building this feature — Daniel runs this himself against
// the real Supabase project before the migration + deploy go out.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRIVATE_BUCKET = process.env.CIC_MEDIA_BUCKET || "clubos-media";
const PUBLIC_BUCKET = process.env.CIC_MEDIA_PREVIEWS_BUCKET || "clubos-media-previews";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function ensureBucket(name: string, isPublic: boolean, fileSizeLimit: number) {
  console.log(`\n→ Target bucket: ${name} (${isPublic ? "public" : "private"})`);
  const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    console.error("  ✗ Cannot list buckets:", listErr.message);
    process.exit(1);
  }
  const existing = buckets?.map((b) => b.name) ?? [];

  if (!existing.includes(name)) {
    console.log(`  → Creating bucket "${name}"…`);
    const { error: createErr } = await supabase.storage.createBucket(name, {
      public: isPublic,
      fileSizeLimit,
    });
    if (createErr) {
      console.error("  ✗ Bucket create failed:", createErr.message);
      process.exit(1);
    }
    console.log("  ✓ Bucket created");
  } else {
    console.log(`  ✓ Bucket "${name}" already exists`);
  }

  console.log("  → Round-trip test (upload → download → delete)…");
  const testPath = `_setup-test/${Date.now()}.txt`;
  const testContent = `${name} round-trip test`;

  const { error: uploadErr } = await supabase.storage
    .from(name)
    .upload(testPath, new Blob([testContent], { type: "text/plain" }), {
      contentType: "text/plain",
      upsert: true,
    });
  if (uploadErr) {
    console.error("  ✗ Upload failed:", uploadErr.message);
    process.exit(1);
  }
  console.log("  ✓ Upload");

  const { data: dlData, error: dlErr } = await supabase.storage.from(name).download(testPath);
  if (dlErr || !dlData) {
    console.error("  ✗ Download failed:", dlErr?.message);
    process.exit(1);
  }
  const dlText = await dlData.text();
  if (dlText !== testContent) {
    console.error(`  ✗ Round-trip content mismatch: got ${JSON.stringify(dlText)}`);
    process.exit(1);
  }
  console.log("  ✓ Download (content matches)");

  const { error: rmErr } = await supabase.storage.from(name).remove([testPath]);
  if (rmErr) {
    console.error("  ✗ Delete failed:", rmErr.message);
    process.exit(1);
  }
  console.log("  ✓ Delete");
}

async function main() {
  console.log(`Project: ${SUPABASE_URL}`);

  // 25MB reference cap matches the existing facility-upload precedent; the
  // media upload endpoint itself enforces its own 50MB/file multer limit —
  // bump this if Max needs to upload bigger source video files directly.
  await ensureBucket(PRIVATE_BUCKET, false, 52428800); // 50 MB
  await ensureBucket(PUBLIC_BUCKET, true, 10485760); // 10 MB (previews/thumbs only, always small)

  console.log("\n✓ CIC Media Library storage is ready.");
}

void main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
