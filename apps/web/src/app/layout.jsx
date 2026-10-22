import { connection } from 'next/server';
import { Inter } from 'next/font/google';
import { Providers } from './providers';
import '@/styles/globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata = {
  title: { default: 'Orbit', template: '%s · Orbit' },
  description: 'Workforce, delivery and client operations for IT services teams.',
};

export default async function RootLayout({ children }) {
  // Every page renders per request so it can carry the CSP nonce set in src/proxy.js.
  await connection();
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
