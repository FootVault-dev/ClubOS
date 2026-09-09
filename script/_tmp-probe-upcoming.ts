
import Stripe from "stripe";

async function probe(label: string, key: string | undefined) {
  console.log(`\n=== ${label} ===`);
  if (!key) { console.log("  no key configured"); return; }
  const s = new Stripe(key, { apiVersion: "2024-06-20" as any });

  const bal = await s.balance.retrieve();
  const sum = (a: any[]) => a.reduce((t, b) => t + b.amount, 0);
  console.log("  balance available:", (sum(bal.available) / 100).toFixed(2), bal.available.map(b => b.currency).join("/"));
  console.log("  balance pending:  ", (sum(bal.pending) / 100).toFixed(2));

  for (const st of ["pending", "in_transit"] as const) {
    const l = await s.payouts.list({ status: st, limit: 10 });
    console.log(`  payouts ${st}: ${l.data.length}`);
    for (const p of l.data) {
      console.log(`    ${p.id}  $${(p.amount/100).toFixed(2)}  arrives ${new Date(p.arrival_date*1000).toISOString().slice(0,10)}  auto=${p.automatic}`);
    }
  }

  const acct = await s.accounts.retrieve();
  const sch: any = (acct as any).settings?.payouts?.schedule;
  console.log("  payout schedule:", JSON.stringify(sch));
  console.log("  payouts enabled:", (acct as any).payouts_enabled);
}

async function main(){
  await probe("CLUB (CUFC/USG)", process.env.STRIPE_SECRET_KEY);
  await probe("GYMNASTICS (CUGC)", process.env.CUGC_STRIPE_SECRET_KEY);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
