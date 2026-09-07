import puppeteer from "puppeteer-core";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.argv[2];
const reg = JSON.stringify({ token: "0".repeat(32), firstName: "Probe", lastName: "Preview", email: "delivered@resend.dev", phone: "+64210000000", category: "Masters" });
(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const shots: [string, number, number, string, boolean][] = [
    ["thank-you-registered-390", 390, 844, "/thank-you", true],
    ["thank-you-registered-1440", 1440, 900, "/thank-you", true],
    ["mens-draw-direct-390", 390, 844, "/mens-draw", false],
    ["mens-draw-direct-1440", 1440, 900, "/mens-draw", false],
  ];
  for (const [name, w, h, path, registered] of shots) {
    const p = await b.newPage();
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await p.goto("http://localhost:4173/", { waitUntil: "networkidle0" });
    await p.evaluate((r, on) => { sessionStorage.clear(); if (on) sessionStorage.setItem("cic7s.registration", r); }, reg, registered);
    await p.goto("http://localhost:4173" + path, { waitUntil: "networkidle0" });
    await p.evaluate(() => document.querySelectorAll(".reveal").forEach((e) => e.classList.add("in")));
    await new Promise((r) => setTimeout(r, 400));
    const sec = await p.$("#secure-your-spot");
    if (sec) { await sec.screenshot({ path: `${OUT}/${name}.png` }); }
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const small = await p.evaluate(() => Array.from(document.querySelectorAll("#secure-your-spot button, #secure-your-spot a, #secure-your-spot input")).filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.height < 44; }).map((e) => (e.textContent || (e as HTMLInputElement).placeholder || "").trim().slice(0, 30) + `:${Math.round(e.getBoundingClientRect().height)}px`));
    console.log(`${name}: section=${sec ? "yes" : "MISSING"} overflow=${overflow}px small-targets=${JSON.stringify(small)}`);
    await p.close();
  }
  await b.close();
})();
