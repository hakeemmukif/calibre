import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';

// Session-only guard (no profile check — this group IS the profile-less
// destination). Chrome-free, matching (auth)/layout.tsx's minimal wrapper.
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect('/login');

  return (
    <main
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-app)',
      }}
    >
      {children}
    </main>
  );
}
