import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { AppShell } from '../AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect('/login');
  return <AppShell user={user}>{children}</AppShell>;
}
