/**
 * Maps API validation details (path "body.email") onto react-hook-form fields. Returns true when
 * at least one field error was set, so callers can fall back to a toast for other errors.
 */
export function applyServerErrors(form, error) {
  let applied = false;
  for (const detail of error?.details ?? []) {
    const field = detail.path?.replace(/^body\./, '');
    if (field && field !== 'body' && form.getValues(field) !== undefined) {
      form.setError(field, { type: 'server', message: detail.message });
      applied = true;
    }
  }
  return applied;
}

/** Converts empty strings from inputs into null for optional API fields. */
export const emptyToNull = (value) => (value === '' || value === undefined ? null : value);
