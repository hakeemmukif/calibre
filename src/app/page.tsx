import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { profileRepo, ProfileMissingError } from '@/server/persistence/repos/profile';

export default async function Home() {
  const user = await getSession();
  if (!user) redirect('/login');

  let hasProfile = false;
  try {
    await profileRepo.get(user.id);
    hasProfile = true;
  } catch (err) {
    if (!(err instanceof ProfileMissingError)) throw err;
  }
  redirect(hasProfile ? '/feed' : '/onboarding');
}
