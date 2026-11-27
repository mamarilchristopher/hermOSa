import { fmtDay } from "@/lib/adsAdvisor";
import { pesoShort, type runningNow } from "@/lib/adsNow";

const NOW_NAME: Record<string, string> = { QC_MAIN: "QC Main", FAIRVIEW: "Fairview", STA_MARIA: "Sta. Maria", MARIKINA: "Marikina" };

/** Business › Ads "Running now" (v0.100.3, CHRIS Nov 28; v0.100.4 "too messy" → one line per ad): per branch,
 *  "Hiko · Women only ₱5k". Budget is per day before VAT. Each line opens its ad set in Ads Manager; the full audience,
 *  spend and ad set names sit in the hover text. */
export function RunningNow({ now, lastDate, setUrl }: { now: ReturnType<typeof runningNow>; lastDate: string | null; setUrl: (id: string, cid: string) => string }) {
  return (
    <section className="card ads-now" aria-label="Ads running now">
      <div className="ads-now-top">
        <h2>Running now</h2>
        <span className="muted small">₱{now.budget.toLocaleString("en-US")}/day before VAT{lastDate ? ` · ${fmtDay(lastDate)}` : ""}</span>
      </div>
      <div className="ads-now-grid">
        {now.branches.map((b) => (
          <div key={b.branch} className="ads-now-branch">
            <div className="ads-now-head"><b>{NOW_NAME[b.branch] ?? b.branch}</b><span>{b.items.length ? pesoShort(b.budget) : "Off"}</span></div>
            {b.items.map((it) => {
              const first = it.sets[0];
              const tip = `${it.audience.label}${it.audience.warn ? " — men still see this ad" : ""}\n${it.sets.map((x) => x.name).join("\n")}\n₱${Math.round(it.spend7 * 1.12).toLocaleString("en-US")}* last 7 days · ${it.chats7} chats`;
              return (
                <a key={`${it.service}|${it.audience.key}`} className="ads-now-row" href={setUrl(first.id, first.cid)} target="_blank" rel="noopener noreferrer" title={tip}>
                  <b>{it.service}</b>
                  <span className={`ads-now-aud${it.audience.warn ? " warn" : ""}`}>{it.audience.short}</span>
                  <b className="ads-now-bud">{it.budget ? pesoShort(it.budget) : "–"}</b>
                </a>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
