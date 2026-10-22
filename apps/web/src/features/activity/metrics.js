// Plain module: formatting and labelling of metrics shared by activity, insights and reports.
import { formatDuration } from '@/lib/format';

export const KIND_LABEL = {
  measured: 'Measured',
  derived: 'Derived',
  estimated: 'Estimated',
};

export const KIND_HINT = {
  measured: 'Counted directly from records.',
  derived: 'Calculated from measured values with a stated formula.',
  estimated: 'Involves a forecast or assumption.',
};

export function formatPercent(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value * 1000) / 10}%`;
}

/** Formats a report cell by its column type. */
export function formatMetric(value, type) {
  if (value === null || value === undefined) return '—';
  if (type === 'duration') return formatDuration(value);
  if (type === 'percent') return formatPercent(value);
  if (type === 'count') return value.toLocaleString();
  return String(value);
}

export const STATUS_LABEL = { PRESENT: 'Present', ABSENT: 'Absent', HOLIDAY: 'Holiday', NONE: '—' };
