/** The evening digest choices Settings offers: off, or an evening hour — plus a time set from the command line,
 * kept as chosen. Shared by the console page and its no-script fallback. */
export function digestTimes(current: string | null): [string, string][] {
  const hours = ["17:00", "18:00", "19:00", "20:00", "21:00", "22:00"];
  const times = current === null || hours.includes(current) ? hours : [...hours, current].sort();
  return [["off", "Off"], ...times.map(one => [one, `At ${one}`] as [string, string])];
}
