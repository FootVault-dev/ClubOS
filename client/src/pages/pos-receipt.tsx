// The customer's receipt — public by 128-bit token, printable, no login.
// Fields follow IRD's taxable-supply-information tiers (shared/pos.ts): the
// GST number is always printed; the buyer's name only appears over $1,000.
import { useEffect, useState } from "react";
import { useRoute } from "wouter";

interface ReceiptLine { title: string; detail: string | null; brand: string; qty: number; unitCents: number; lineCents: number }
interface Receipt {
  seller: { legalName: string; gstNumber: string; address: string };
  saleNumber: string; paidAt: string; status: string; tier: string;
  lines: ReceiptLine[];
  subtotalCents: number; discountCents: number; roundingCents: number; totalCents: number; gstCents: number;
  payments: { label: string; amountCents: number; reference: string | null }[];
  refunds: { amountCents: number; at: string }[];
  customerName: string | null; servedBy: string | null;
}
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function PosReceipt() {
  const [, params] = useRoute("/receipt/:token");
  const [data, setData] = useState<Receipt | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  useEffect(() => {
    let alive = true;
    fetch(`/api/public/pos/receipt/${params?.token ?? ""}`)
      .then(async (r) => { if (!alive) return; if (r.status === 404) return setState("missing"); if (!r.ok) return setState("error"); setData(await r.json()); setState("ok"); })
      .catch(() => alive && setState("error"));
    return () => { alive = false; };
  }, [params?.token]);

  const brand = data ? (Array.from(new Set(data.lines.map((l) => l.brand))).length === 1 ? data.lines[0]?.brand : "Christchurch United") : "";
  const when = data?.paidAt ? new Date(data.paidAt).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", dateStyle: "medium", timeStyle: "short" }) : "";

  return (
    <div style={{ background: "#ededed", minHeight: "100vh", padding: "24px 12px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", color: "#161616" }}>
      <style>{`@media print { body { background: #fff !important; } .no-print { display: none !important; } .card { box-shadow: none !important; } }`}</style>
      <div className="card" style={{ maxWidth: 560, margin: "0 auto", background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 1px 2px rgba(31,28,28,.06), 0 8px 24px rgba(31,28,28,.08)" }}>
        {state === "loading" && <p style={{ color: "#6b6b6b" }}>Loading your receipt…</p>}
        {state === "missing" && <p>We couldn't find that receipt. Check the link in your email, or ask at the counter.</p>}
        {state === "error" && <p>Something went wrong loading this receipt. Try again in a minute.</p>}
        {state === "ok" && data && (
          <>
            <div style={{ fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", color: "#6b6b6b" }}>Receipt</div>
            <h1 style={{ margin: "4px 0 2px", fontSize: 22 }}>{brand}</h1>
            <div style={{ color: "#6b6b6b", fontSize: 13 }}>{data.seller.legalName} · GST {data.seller.gstNumber}</div>
            <div style={{ color: "#6b6b6b", fontSize: 13, marginTop: 10 }}>{data.saleNumber} · {when}{data.servedBy ? ` · served by ${data.servedBy}` : ""}</div>
            {data.customerName && <div style={{ color: "#6b6b6b", fontSize: 13 }}>Customer: {data.customerName}</div>}
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 18 }}>
              <tbody>
                {data.lines.map((l, i) => (
                  <tr key={i}>
                    <td style={{ padding: "8px 0", borderBottom: "1px solid #eee", fontSize: 14 }}>{l.title}{l.detail && <div style={{ color: "#6b6b6b", fontSize: 12 }}>{l.detail}</div>}<div style={{ color: "#9a9a9a", fontSize: 11 }}>{l.brand}</div></td>
                    <td style={{ padding: "8px 0", borderBottom: "1px solid #eee", color: "#6b6b6b", fontSize: 13, textAlign: "center", whiteSpace: "nowrap" }}>{l.qty} × {money(l.unitCents)}</td>
                    <td style={{ padding: "8px 0", borderBottom: "1px solid #eee", fontSize: 14, textAlign: "right", whiteSpace: "nowrap" }}>{money(l.lineCents)}</td>
                  </tr>
                ))}
                <Tot label="Subtotal" cents={data.subtotalCents} />
                {data.discountCents > 0 && <Tot label="Discount" cents={-data.discountCents} />}
                {data.roundingCents !== 0 && <Tot label="Cash rounding" cents={data.roundingCents} />}
                <Tot label="Total (incl. GST)" cents={data.totalCents} strong />
                <Tot label="GST content included" cents={data.gstCents} />
                {data.payments.map((p, i) => <Tot key={`p${i}`} label={`Paid by ${p.label}${p.reference ? ` (${p.reference})` : ""}`} cents={p.amountCents} />)}
                {data.refunds.map((r, i) => <Tot key={`r${i}`} label="Refunded" cents={-r.amountCents} />)}
              </tbody>
            </table>
            <p style={{ color: "#9a9a9a", fontSize: 11, lineHeight: 1.6, margin: "18px 0 0" }}>{data.seller.address}. Keep this receipt as your proof of purchase. Your rights under the Consumer Guarantees Act are not affected by anything here.</p>
            <button className="no-print" onClick={() => window.print()} style={{ marginTop: 16, height: 40, padding: "0 16px", borderRadius: 10, border: "1px solid #d4d4d4", background: "#fff", fontSize: 14, cursor: "pointer" }}>Print</button>
          </>
        )}
      </div>
    </div>
  );
}

function Tot({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <tr>
      <td colSpan={2} style={{ padding: "4px 0", color: strong ? "#161616" : "#6b6b6b", fontSize: strong ? 15 : 13, textAlign: "right", fontWeight: strong ? 700 : 400 }}>{label}</td>
      <td style={{ padding: "4px 0", fontSize: strong ? 15 : 13, textAlign: "right", whiteSpace: "nowrap", fontWeight: strong ? 700 : 400 }}>{money(cents)}</td>
    </tr>
  );
}
