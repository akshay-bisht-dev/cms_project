// Converting between wall-clock inputs in a member's time zone and UTC instants. Browsers only
// offer local-time inputs, so the zone's offset at that wall-clock time is computed with Intl.

function partsIn(date, zone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
}

/** "2026-10-20T09:30" interpreted in `zone` → ISO instant. */
export function zonedInputToIso(local, zone) {
  const guess = new Date(`${local}:00Z`);
  const p = partsIn(guess, zone);
  const asZone = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return new Date(guess.getTime() - (asZone - guess.getTime())).toISOString();
}

/** ISO instant → { date: "YYYY-MM-DD", time: "HH:MM", local: "YYYY-MM-DDTHH:MM" } in `zone`. */
export function isoToZonedInput(iso, zone) {
  const p = partsIn(new Date(iso), zone);
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { date, time, local: `${date}T${time}` };
}
