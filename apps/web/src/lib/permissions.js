/** Client-side permission checks for showing or hiding UI. The API enforces the real rules. */
export function can(me, key, scope) {
  const entry = me?.permissions?.find((p) => p.key === key);
  if (!entry) return false;
  return scope ? entry.scopes.includes(scope) : true;
}

export function canAny(me, keys) {
  return keys.some((key) => can(me, key));
}
