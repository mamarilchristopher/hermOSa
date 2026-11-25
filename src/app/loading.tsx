/** Shown right away while the next page loads, so a tap never looks like it did nothing on a slow phone. */
export default function Loading() {
  return (
    <main className="page-loading" aria-busy="true" aria-live="polite">
      <span className="page-spinner" aria-hidden />
      <span className="muted small">Loading…</span>
    </main>
  );
}
