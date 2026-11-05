const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : formatter.format(date);
}
export function formatRelative(value: string, now = Date.now()) {
  const seconds = (Date.parse(value) - now) / 1000;
  if (!Number.isFinite(seconds)) return 'Unknown time';
  if (Math.abs(seconds) < 60) return relative.format(Math.round(seconds), 'second');
  if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (Math.abs(seconds) < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}
