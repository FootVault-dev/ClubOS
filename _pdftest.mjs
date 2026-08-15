const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
// A tiny valid PDF with a text layer, built inline.
const pdfB64 = "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSAxOCBUZgoyMCAxMDAgVGQKKEhlbGxvIENsdWIgRHJpdmUpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4K";
const buf = Buffer.from(pdfB64, "base64");
try {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, isEvalSupported: false, useSystemFonts: false }).promise;
  const page = await doc.getPage(1);
  const c = await page.getTextContent();
  console.log("OK pages:", doc.numPages, "text:", JSON.stringify(c.items.map(i => i.str).join(" ")));
} catch (e) {
  console.log("THREW:", e?.constructor?.name, "| message:", JSON.stringify(e?.message), "| str:", String(e).slice(0,200));
}
