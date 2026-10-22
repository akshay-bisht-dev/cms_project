'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { emailSchema, passwordSchema, z } from '@orbit/validation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { AuthHeading, FormAlert } from './auth-card';

const backToSignIn = (
  <p className="mt-6 text-center text-sm">
    <Link href="/login" className="font-medium text-primary hover:underline">
      Back to sign in
    </Link>
  </p>
);

const newPasswordFields = {
  password: passwordSchema,
  confirm: z.string(),
};
const matchPasswords = (schema) => schema.refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const form = useForm({ resolver: zodResolver(z.object({ email: emailSchema })), defaultValues: { email: '' } });
  async function onSubmit(values) {
    await api.post('/auth/forgot-password', values).catch(() => {});
    setSent(true);
  }
  return (
    <>
      <AuthHeading title="Reset your password" description="We will email you a link to choose a new password." />
      {sent ? (
        <FormAlert tone="success">If an account exists for that email, a reset link is on its way. It expires in 30 minutes.</FormAlert>
      ) : (
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <FormField label="Work email" error={form.formState.errors.email?.message}>
            {(aria) => <Input type="email" autoComplete="username" autoFocus {...aria} {...form.register('email')} />}
          </FormField>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            Send reset link
          </Button>
        </form>
      )}
      {backToSignIn}
    </>
  );
}

export function ResetPasswordForm() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const [error, setError] = useState(token ? null : 'This link is missing its token. Request a new one.');
  const form = useForm({ resolver: zodResolver(matchPasswords(z.object(newPasswordFields))), defaultValues: { password: '', confirm: '' } });
  async function onSubmit({ password }) {
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password });
      router.replace('/login?reason=password-reset');
    } catch (err) {
      if (!applyServerErrors(form, err)) setError(err.message);
    }
  }
  return (
    <>
      <AuthHeading title="Choose a new password" description="Use at least 12 characters. Signing in elsewhere will end." />
      <FormAlert>{error}</FormAlert>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
        <FormField label="New password" error={form.formState.errors.password?.message}>
          {(aria) => <Input type="password" autoComplete="new-password" {...aria} {...form.register('password')} />}
        </FormField>
        <FormField label="Confirm password" error={form.formState.errors.confirm?.message}>
          {(aria) => <Input type="password" autoComplete="new-password" {...aria} {...form.register('confirm')} />}
        </FormField>
        <Button type="submit" disabled={!token || form.formState.isSubmitting}>
          Set password
        </Button>
      </form>
      {backToSignIn}
    </>
  );
}

export function VerifyEmail() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState(token ? 'pending' : 'error');
  const started = useRef(false);
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api.post('/auth/verify-email', { token }).then(() => setState('done'), () => setState('error'));
  }, [token]);
  return (
    <>
      <AuthHeading title="Email verification" />
      {state === 'pending' && <p className="text-sm text-muted-foreground" role="status">Verifying your email…</p>}
      {state === 'done' && <FormAlert tone="success">Your email is verified. You can sign in now.</FormAlert>}
      {state === 'error' && <FormAlert>This verification link is invalid or has expired. Sign in to request a new one.</FormAlert>}
      {backToSignIn}
    </>
  );
}

export function AcceptInvitation() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const [invitation, setInvitation] = useState(null);
  const [error, setError] = useState(token ? null : 'This invitation link is missing its token.');
  const form = useForm({
    resolver: zodResolver(
      z.object({ name: z.string().trim().max(160), ...newPasswordFields }).refine((v) => !invitation?.requiresPassword || v.password === v.confirm, {
        path: ['confirm'],
        message: 'Passwords do not match',
      }),
    ),
    defaultValues: { name: '', password: '', confirm: '' },
  });

  useEffect(() => {
    if (!token) return;
    api
      .get('/auth/invitation', { query: { token } })
      .then(({ data }) => {
        setInvitation(data);
        form.reset({ name: data.name, password: '', confirm: '' });
      })
      .catch((err) => setError(err.message));
  }, [token, form]);

  async function accept(values) {
    setError(null);
    try {
      await api.post('/auth/accept-invitation', invitation.requiresPassword ? { token, name: values.name, password: values.password } : { token });
      router.replace('/login?reason=invitation-accepted');
    } catch (err) {
      if (!applyServerErrors(form, err)) setError(err.message);
    }
  }

  if (!invitation) {
    return (
      <>
        <AuthHeading title="Join your team" />
        {error ? <FormAlert>{error}</FormAlert> : <p role="status" className="text-sm text-muted-foreground">Loading invitation…</p>}
        {backToSignIn}
      </>
    );
  }
  return (
    <>
      <AuthHeading title={`Join ${invitation.organizationName}`} description={`You were invited as ${invitation.email}.`} />
      <FormAlert>{error}</FormAlert>
      {invitation.requiresPassword ? (
        <form onSubmit={form.handleSubmit(accept)} noValidate className="grid gap-4">
          <FormField label="Your name" error={form.formState.errors.name?.message}>
            {(aria) => <Input autoComplete="name" {...aria} {...form.register('name')} />}
          </FormField>
          <FormField label="Password" hint="At least 12 characters." error={form.formState.errors.password?.message}>
            {(aria) => <Input type="password" autoComplete="new-password" {...aria} {...form.register('password')} />}
          </FormField>
          <FormField label="Confirm password" error={form.formState.errors.confirm?.message}>
            {(aria) => <Input type="password" autoComplete="new-password" {...aria} {...form.register('confirm')} />}
          </FormField>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            Accept and create account
          </Button>
        </form>
      ) : (
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">You already have an Orbit account. Accept to add this organization to it.</p>
          <Button onClick={() => accept({})}>Accept invitation</Button>
        </div>
      )}
    </>
  );
}

const registerSchema = matchPasswords(
  z.object({
    organizationName: z.string().trim().min(2, 'Enter your organization name').max(160),
    ownerName: z.string().trim().min(1, 'Enter your name').max(160),
    email: emailSchema,
    timeZone: z.string().min(1),
    baseCurrency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
    ...newPasswordFields,
  }),
);

export function RegisterForm() {
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const form = useForm({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      organizationName: '',
      ownerName: '',
      email: '',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
      baseCurrency: 'USD',
      password: '',
      confirm: '',
    },
  });
  async function onSubmit({ confirm: _confirm, ...values }) {
    setError(null);
    try {
      await api.post('/organizations', values);
      setDone(values.email);
    } catch (err) {
      if (!applyServerErrors(form, err)) setError(err.message);
    }
  }
  if (done) {
    return (
      <>
        <AuthHeading title="Check your email" />
        <FormAlert tone="success">We sent a verification link to {done}. Verify your address, then sign in.</FormAlert>
        {backToSignIn}
      </>
    );
  }
  const e = form.formState.errors;
  return (
    <>
      <AuthHeading title="Create your organization" description="You will be its owner. You can invite your team next." />
      <FormAlert>{error}</FormAlert>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
        <FormField label="Organization name" required error={e.organizationName?.message}>
          {(aria) => <Input autoFocus {...aria} {...form.register('organizationName')} />}
        </FormField>
        <FormField label="Your name" required error={e.ownerName?.message}>
          {(aria) => <Input autoComplete="name" {...aria} {...form.register('ownerName')} />}
        </FormField>
        <FormField label="Work email" required error={e.email?.message}>
          {(aria) => <Input type="email" autoComplete="username" {...aria} {...form.register('email')} />}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Time zone" error={e.timeZone?.message}>
            {(aria) => <Input {...aria} {...form.register('timeZone')} />}
          </FormField>
          <FormField label="Currency" error={e.baseCurrency?.message}>
            {(aria) => <Input maxLength={3} {...aria} {...form.register('baseCurrency', { setValueAs: (v) => v.toUpperCase() })} />}
          </FormField>
        </div>
        <FormField label="Password" required hint="At least 12 characters." error={e.password?.message}>
          {(aria) => <Input type="password" autoComplete="new-password" {...aria} {...form.register('password')} />}
        </FormField>
        <FormField label="Confirm password" required error={e.confirm?.message}>
          {(aria) => <Input type="password" autoComplete="new-password" {...aria} {...form.register('confirm')} />}
        </FormField>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Create organization
        </Button>
      </form>
      {backToSignIn}
    </>
  );
}
