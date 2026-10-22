import { CircleAlert, CircleCheck } from 'lucide-react';

export function AuthHeading({ title, description }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export function FormAlert({ tone = 'error', children }) {
  if (!children) return null;
  const error = tone === 'error';
  const Icon = error ? CircleAlert : CircleCheck;
  return (
    <div role={error ? 'alert' : 'status'} className={`mb-4 flex items-start gap-2 rounded-md p-3 text-sm ${error ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
