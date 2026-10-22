'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Copy } from 'lucide-react';
import { z } from '@orbit/validation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api';
import { FormAlert } from './auth-card';

/** TOTP enrollment: QR code → confirm a code → show recovery codes once. */
export function MfaEnrollment({ onComplete }) {
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState(null);
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState(null);
  const form = useForm({ resolver: zodResolver(z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') })), defaultValues: { code: '' } });

  async function start() {
    setError(null);
    try {
      const { data } = await api.post('/auth/mfa/setup');
      setSetup(data);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (setup) QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 192 }).then(setQr);
  }, [setup]);

  async function confirm({ code }) {
    setError(null);
    try {
      const { data } = await api.post('/auth/mfa/enable', { code });
      setCodes(data.recoveryCodes);
    } catch (err) {
      setError(err.details?.[0]?.message ?? err.message);
    }
  }

  if (codes) {
    return (
      <div className="grid gap-4">
        <FormAlert tone="success">Two-factor authentication is on.</FormAlert>
        <p className="text-sm">
          Save these recovery codes somewhere safe. Each works once if you lose your device. <strong>They will not be shown again.</strong>
        </p>
        <ul className="grid grid-cols-2 gap-2 rounded-md bg-muted p-3 font-mono text-sm" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>
            <Copy aria-hidden /> Copy codes
          </Button>
          <Button onClick={onComplete}>I have saved them</Button>
        </div>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="grid gap-3">
        <FormAlert>{error}</FormAlert>
        <p className="text-sm text-muted-foreground">Use an authenticator app such as 1Password, Google Authenticator or Microsoft Authenticator.</p>
        <Button onClick={start} className="justify-self-start">
          Set up two-factor authentication
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <FormAlert>{error}</FormAlert>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Scan this QR code with your authenticator app.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex flex-col items-center gap-2">
        {/* A locally generated data: URL; next/image optimization does not apply. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {qr ? <img src={qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded border" /> : <div className="size-48 animate-pulse rounded bg-muted" />}
        <p className="text-xs text-muted-foreground">
          Can’t scan? Enter this key: <code className="font-mono break-all text-foreground">{setup.secret}</code>
        </p>
      </div>
      <form onSubmit={form.handleSubmit(confirm)} noValidate className="grid gap-3">
        <FormField label="Verification code" error={form.formState.errors.code?.message}>
          {(aria) => <Input inputMode="numeric" autoComplete="one-time-code" {...aria} {...form.register('code')} />}
        </FormField>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Turn on two-factor authentication
        </Button>
      </form>
    </div>
  );
}
