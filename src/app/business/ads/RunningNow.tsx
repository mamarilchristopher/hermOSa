import { fmtDay } from "@/lib/adsAdvisor";
import { pesoShort, type runningNow } from "@/lib/adsNow";

const NOW_NAME: Record<string, string> = { QC_MAIN: "QC Main", FAIRVIEW: "Fairview", STA_MARIA: "Sta. Maria", MARIKINA: "Marikina" };
const peso = (pesos: number) => `₱${pesos.toLocaleString("en-US")}`;

/** Business › Ads "Running now" (v0.100.3, CHRIS Nov 28): per branch, each live service + audience with its daily budget
 *  before VAT, last week's spend with VAT (*), and each ad set as a link into Ads Manager. */
export function RunningNow({ now, lastDate, setUrl }: { now: ReturnType<typeof runningNow>; lastDate: string | null; setUrl: (id: string, cid: string) => string }) {
  return (
    <section className="card ads-now" aria-label="Ads running now">
      <h2>Running now <small>live ad sets · daily budget before VAT{lastDate ? ` · data to ${fmtDay(lastDate)}` : ""}</small></h2>
      <div className="ads-now-grid">
        {now.branches.map((b) => (
          <div key={b.branch} className="ads-now-branch">
            <div className="ads-now-head"><b>{NOW_NAME[b.branch] ?? b.branch}</b><span>{b.items.length ? `${pesoShort(b.budget)}/day` : "No live ads"}</span></div>
            {b.items.length > 0 && (
              <ul>
                {b.items.map((it) => (
                  <li key={`${it.service}|${it.audience.key}`} className={it.audience.warn ? "warn" : undefined}>
                    <div className="ads-now-row">
                      <span><b>{it.service}</b> <span className="ads-now-aud">{it.audience.label}</span></span>
                      <b className="ads-now-bud">{it.budget ? pesoShort(it.budget) : "–"}</b>
                    </div>
                    <div className="small muted">
                      {it.sets.map((x, i) => <span key={x.id}>{i > 0 && ", "}<a href={setUrl(x.id, x.cid)} target="_blank" rel="noopener noreferrer">{x.name || "ad set"} ↗</a></span>)}
                      {` · ${it.spend7 > 0 ? `₱${Math.round(it.spend7 * 1.12).toLocaleString("en-US")}* last 7 days · ${it.chats7.toLocaleString("en-US")} chats` : "no spend last 7 days"}`}
                      {it.budgetSource === "campaign" && " · campaign budget share"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <div className="small muted ads-now-foot">All branches: {peso(now.budget)}/day before VAT ({peso(Math.round(now.budget * 1.12))}* with VAT) across {now.sets} ad set{now.sets === 1 ? "" : "s"}. Tap an ad set to open it in Ads Manager.</div>
    </section>
  );
}
