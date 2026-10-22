'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Building2, ChevronRight, LoaderCircle } from 'lucide-react';
import { emailSchema, z } from '@orbit/validation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api';
import { AuthHeading, FormAlert } from './auth-card';

const credentialsSchema = z.object({ email: emailSchema, password: z.string().min(1, 'Enter your password') });
const codeSchema = z.object({ code: z.string().trim().min(6, 'Enter the code from your app').max(32) });

const MESSAGES = {
  INVALID_CREDENTIALS: 'Invalid email or password.',
  ACCOUNT_LOCKED: 'Too many failed attempts. Try again later or reset your password.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
};

const REASONS = {
  'session-ended': { tone: 'error', text: 'Your session ended. Sign in again.' },
  'password-reset': { tone: 'success', text: 'Your password was changed. Sign in with the new password.' },
  'invitation-accepted': { tone: 'success', text: 'Welcome aboard! Sign in to continue.' },
};

function safeNext(value) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/my-dashboard';
}

export function LoginFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState(params.get('step') ?? 'credentials');
  const [organizations, setOrganizations] = useState([]);
  const [alert, setAlert] = useState(REASONS[params.get('reason')] ?? null);

  const finish = () => {
    router.replace(next);
    router.refresh();
  };

  async function afterAuthentication() {
    const { data: me } = await api.get('/auth/me');
    if (me.organization) return finish();
    setOrganizations(me.organizations);
    setStep('organization');
  }

  useEffect(() => {
    // Arriving from the app with a session that still needs an organization.
    if (step === 'organization' && organizations.length === 0) {
      api.get('/auth/me').then(({ data }) => setOrganizations(data.organizations)).catch(() => setStep('credentials'));
    }
  }, [step, organizations.length]);

  if (step === 'mfa') return <MfaStep onDone={afterAuthentication} onBack={() => setStep('credentials')} />;
  if (step === 'organization') return <OrganizationStep organizations={organizations} onDone={finish} />;
  return (
    <CredentialsStep
      alert={alert}
      setAlert={setAlert}
      onResult={(data) => {
        if (data.status === 'MFA_REQUIRED') setStep('mfa');
        else if (data.status === 'ORGANIZATION_SELECTION_REQUIRED') {
          setOrganizations(data.organizations);
          setStep('organization');
        } else finish();
      }}
    />
  );
}

function CredentialsStep({ onResult, alert, setAlert }) {
  const form = useForm({ resolver: zodResolver(credentialsSchema), defaultValues: { email: '', password: '' } });
  const [unverifiedEmail, setUnverifiedEmail] = useState(null);

  async function onSubmit(values) {
    setAlert(null);
    try {
      const { data } = await api.post('/auth/login', values);
      onResult(data);
    } catch (error) {
      if (error.code === 'EMAIL_NOT_VERIFIED') setUnverifiedEmail(values.email);
      setAlert({ tone: 'error', text: MESSAGES[error.code] ?? error.message });
    }
  }

  async function resend() {
    await api.post('/auth/resend-verification', { email: unverifiedEmail }).catch(() => {});
    setUnverifiedEmail(null);
    setAlert({ tone: 'success', text: 'If your account needs verification, a new email is on its way.' });
  }

  const { errors, isSubmitting } = form.formState;
  return (
    <>
      <AuthHeading title="Sign in" description="Welcome back. Sign in to your organization." />
      <FormAlert tone={alert?.tone}>
        {alert?.text}
        {unverifiedEmail && (
          <button type="button" className="mt-1 block font-medium underline" onClick={resend}>
            Resend verification email
          </button>
        )}
      </FormAlert>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
        <FormField label="Work email" error={errors.email?.message}>
          {(aria) => <Input type="email" autoComplete="username" autoFocus {...aria} {...form.register('email')} />}
        </FormField>
        <FormField label="Password" error={errors.password?.message}>
          {(aria) => <Input type="password" autoComplete="current-password" {...aria} {...form.register('password')} />}
        </FormField>
        <div className="flex justify-end text-sm">
          <Link href="/forgot-password" className="text-primary hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <LoaderCircle className="animate-spin" aria-hidden />}
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New to Orbit?{' '}
        <Link href="/register" className="font-medium text-primary hover:underline">
          Create an organization
        </Link>
      </p>
    </>
  );
}

function MfaStep({ onDone, onBack }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState(null);
  const form = useForm({ resolver: zodResolver(codeSchema), defaultValues: { code: '' } });

  async function onSubmit({ code }) {
    setError(null);
    try {
      await api.post('/auth/mfa/verify', useRecovery ? { recoveryCode: code } : { code });
      await onDone();
    } catch (err) {
      setError(err.code === 'RATE_LIMITED' ? MESSAGES.RATE_LIMITED : err.message);
      form.reset({ code: '' });
    }
  }

  return (
    <>
      <AuthHeading
        title="Two-factor verification"
        description={useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}
      />
      <FormAlert>{error}</FormAlert>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
        <FormField label={useRecovery ? 'Recovery code' : 'Verification code'} error={form.formState.errors.code?.message}>
          {(aria) => (
            <Input
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              autoFocus
              {...aria}
              {...form.register('code')}
            />
          )}
        </FormField>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Verify
        </Button>
      </form>
      <div className="mt-4 flex justify-between text-sm">
        <button type="button" className="text-primary hover:underline" onClick={() => setUseRecovery((v) => !v)}>
          {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
        </button>
        <button type="button" className="text-muted-foreground hover:underline" onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}

function OrganizationStep({ organizations, onDone }) {
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  async function choose(organizationId) {
    setPending(organizationId);
    setError(null);
    try {
      await api.post('/auth/select-organization', { organizationId });
      onDone();
    } catch (err) {
      setError(err.message);
      setPending(null);
    }
  }
  return (
    <>
      <AuthHeading title="Choose an organization" description="Your account belongs to more than one organization." />
      <FormAlert>{error}</FormAlert>
      <ul className="grid gap-2">
        {organizations.map((org) => (
          <li key={org.id}>
            <button
              type="button"
              onClick={() => choose(org.id)}
              disabled={Boolean(pending)}
              className="flex w-full items-center gap-3 rounded-md border p-3 text-left hover:bg-muted disabled:opacity-60"
            >
              <Building2 className="size-5 text-primary" aria-hidden />
              <span className="flex-1 font-medium">{org.name}</span>
              {pending === org.id ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
