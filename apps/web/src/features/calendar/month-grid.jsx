'use client';

import Link from 'next/link';
import { addDays } from '@/lib/format';
import { cn } from '@/lib/utils';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TONES = {
  holidays: 'bg-info/10 text-info',
  milestones: 'bg-warning/10 text-warning',
  tasks: 'bg-primary/10 text-primary',
  meetings: 'bg-success/10 text-success',
};

/** Weeks (Monday first) covering a month: [[iso, iso, …7], …]. */
export function monthWeeks(month) {
  const first = `${month}-01`;
  const weekday = new Date(`${first}T00:00:00Z`).getUTCDay() || 7;
  let cursor = addDays(first, -(weekday - 1));
  const weeks = [];
  do {
    weeks.push([...Array(7)].map((_, i) => addDays(cursor, i)));
    cursor = addDays(cursor, 7);
  } while (cursor.slice(0, 7) === month);
  return weeks;
}

/**
 * Month grid of all-day and timed items: { id, start (date or ISO), title, source, link, done }.
 * Each day is a list so screen readers get a structured agenda, not just a visual grid.
 */
export function MonthGrid({ month, items, today, onDayClick, maxPerDay = 3 }) {
  const byDay = {};
  for (const item of items) (byDay[String(item.start).slice(0, 10)] ??= []).push(item);
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[42rem] grid-cols-7 border-t border-l text-sm">
        {WEEKDAYS.map((d) => (
          <div key={d} className="border-r border-b bg-muted/60 px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {d}
          </div>
        ))}
        {monthWeeks(month).flat().map((day) => {
          const list = byDay[day] ?? [];
          const outside = day.slice(0, 7) !== month;
          const label = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
          return (
            <section key={day} aria-label={`${label}, ${list.length} item${list.length === 1 ? '' : 's'}`} className={cn('min-h-28 min-w-0 overflow-hidden border-r border-b p-1.5', outside && 'bg-muted/30')}>
              <button
                type="button"
                onClick={() => onDayClick?.(day)}
                disabled={!onDayClick}
                className={cn('mb-1 inline-flex size-6 items-center justify-center rounded-full text-xs', day === today ? 'bg-primary font-semibold text-primary-foreground' : outside ? 'text-muted-foreground' : '')}
                aria-label={onDayClick ? `Add on ${label}` : label}
              >
                {Number(day.slice(8))}
              </button>
              <ul className="grid min-w-0 gap-1">
                {list.slice(0, maxPerDay).map((item) => {
                  const body = (
                    <span className={cn('block truncate rounded px-1.5 py-0.5 text-xs', TONES[item.source], item.done && 'line-through')}>
                      {item.allDay === false && <span className="mr-1 tabular-nums">{new Date(item.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                      {item.title}
                      {item.done && <span className="sr-only"> (done)</span>}
                    </span>
                  );
                  return <li key={item.id} className="min-w-0">{item.link ? <Link href={item.link}>{body}</Link> : body}</li>;
                })}
                {list.length > maxPerDay && <li className="px-1.5 text-xs text-muted-foreground">+{list.length - maxPerDay} more</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
