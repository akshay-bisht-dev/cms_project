import { SettingsNav } from '@/features/settings/settings-nav';

export default function SettingsLayout({ children }) {
  return (
    <>
      <SettingsNav />
      {children}
    </>
  );
}
