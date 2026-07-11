import Link from 'next/link';
import '@/caliber-ui/styles/tokens.css';

// Minimal spine nav — not a designed component, just enough to move between
// the F1–F6 pages (task-B10-brief.md: "wiring only, no new design").
function Nav() {
  return (
    <nav style={{ display: 'flex', gap: 16, padding: '10px 24px', borderBottom: '1px solid var(--border)' }}>
      <Link href="/resume">Résumé</Link>
      <Link href="/feed">Feed</Link>
      <Link href="/tracker">Tracker</Link>
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
