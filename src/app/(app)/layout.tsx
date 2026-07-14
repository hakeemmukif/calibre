import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { profileRepo, ProfileMissingError } from '@/server/persistence/repos/profile';
import { AppShell } from '../AppShell';

// Session AND profile guard: every page under (app) reads the profile
// (feed/jobs/tracker/etc.), so a profile-less registrant must never reach
// them (that 404s as ProfileMissingError deep in a page and would 500).
// Onboarding lives outside this group (see (onboarding)/layout.tsx) so this
// redirect can't loop.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect('/login');

  let hasProfile = false;
  try {
    await profileRepo.get(user.id);
    hasProfile = true;
  } catch (err) {
    if (!(err instanceof ProfileMissingError)) throw err;
  }
  if (!hasProfile) redirect('/onboarding');

  return <AppShell user={user}>{children}</AppShell>;
}
