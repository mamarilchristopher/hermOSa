import Link from "next/link";

/** v0.106.8: a wrong or old link lands here, with a way back. */
export default function NotFound() {
  return (
    <main className="page-error">
      <div className="card">
        <h1>Page not found</h1>
        <p className="muted">The link may be old, or the page moved.</p>
        <div className="row-buttons"><Link className="button" href="/me">Go to Home</Link></div>
      </div>
    </main>
  );
}
