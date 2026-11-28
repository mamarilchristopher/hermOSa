"use client";
import Link from "next/link";

/** v0.106.8: a page that fails to load says so in plain words, with Try again, instead of a blank screen. */
export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page-error">
      <div className="card">
        <h1>This page didn&apos;t load</h1>
        <p className="muted">It may be the connection. Your saved work is safe.</p>
        <div className="row-buttons">
          <button type="button" onClick={() => reset()}>Try again</button>
          <Link className="button secondary" href="/me">Go to Home</Link>
        </div>
      </div>
    </main>
  );
}
