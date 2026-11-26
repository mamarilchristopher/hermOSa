import { parseChangelog, releasesText, releaseText } from "@/lib/changelog";
import { VERSION as APP_VERSION } from "@/lib/version";
import { CopyButton } from "./CopyButton";

/** The list itself (also used by the design preview). */
export function UpdatesList() {
  const releases = parseChangelog(process.env.HERMOSA_CHANGELOG ?? "");
  const days: { date: string; list: typeof releases }[] = [];
  for (const r of releases) {
    const d = days.find((x) => x.date === r.date);
    if (d) d.list.push(r); else days.push({ date: r.date, list: [r] });
  }
  const latest = days[0];
  return (
      <main className="updates-page">
        <div className="card updates-head">
          <div>
            <h1>Hermosa OS updates</h1>
            <p className="muted small">Now on v{APP_VERSION}. Every update put live, newest first. Copy a version or a whole day to paste into the management chat.</p>
          </div>
          {latest && (
            <div className="updates-actions">
              <CopyButton text={releasesText(`HERMOSA OS UPDATES, ${latest.date}`, latest.list)} label="Copy latest day" className="" />
              <CopyButton text={releasesText("HERMOSA OS UPDATES (newest first)", releases)} label="Copy everything" />
            </div>
          )}
        </div>
        {releases.length === 0 && <p className="muted">The version log isn&apos;t in this build.</p>}
        {days.map((d) => (
          <section key={d.date} className="updates-day">
            <h2>{d.date} <span className="small muted">{d.list.length} {d.list.length === 1 ? "update" : "updates"}</span></h2>
            {d.list.map((r) => (
              <article key={r.version} className="card updates-ver">
                <div className="updates-ver-top">
                  <strong>v{r.version}</strong>
                  {r.version === APP_VERSION && <span className="pill PUBLISHED">Current</span>}
                  <CopyButton text={releaseText(r)} />
                </div>
                <ul>{r.items.map((i, k) => <li key={k}>{i}</li>)}</ul>
              </article>
            ))}
          </section>
        ))}
      </main>
  );
}
