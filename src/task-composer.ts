/** UI choices translate into the same digest-bound schedules as the CLI. */
import { parseSchedule, scheduleText, validTimezone, type Schedule } from "./routine.js";
import { templateByName } from "./templates.js";

export function composerSchedule(fields: URLSearchParams): { ok: true; schedule: string | null } | { ok: false; message: string } {
  const repeat = fields.get("repeat") ?? "once";
  if (repeat === "once") return { ok: true, schedule: null };
  if (!["daily", "weekly", "custom"].includes(repeat)) return { ok: false, message: "Choose how often this task repeats." };
  if (repeat === "custom") {
    const count = Number(fields.get("interval"));
    const unit = fields.get("interval-unit");
    const multiplier = unit === "minutes" ? 1 : unit === "hours" ? 60 : unit === "days" ? 1440 : 0;
    if (!Number.isInteger(count) || count < 1 || multiplier === 0 || parseSchedule(`every:${count * multiplier}`) === null) return { ok: false, message: "Choose an interval between 5 minutes and 7 days." };
    return { ok: true, schedule: `every:${count * multiplier}` };
  }
  const time = fields.get("time") ?? "";
  const timezone = fields.get("timezone") ?? "UTC";
  if (!validTimezone(timezone)) return { ok: false, message: "Choose a valid timezone." };
  const text = `${repeat === "weekly" ? `weekly:${fields.get("weekday") ?? ""}` : "daily"}:${time}@${timezone}`;
  const schedule = parseSchedule(text);
  return schedule === null ? { ok: false, message: "Choose a valid time and day for this task." } : { ok: true, schedule: scheduleText(schedule) };
}

export function scheduleFields(schedule: Schedule): Record<string, string> {
  if (schedule.kind === "every") {
    const unit = schedule.minutes % 1440 === 0 ? "days" : schedule.minutes % 60 === 0 ? "hours" : "minutes";
    return { repeat: "custom", interval: String(schedule.minutes / (unit === "days" ? 1440 : unit === "hours" ? 60 : 1)), "interval-unit": unit };
  }
  return { repeat: schedule.kind, time: schedule.hhmm, timezone: schedule.timezone ?? "UTC", ...(schedule.kind === "weekly" ? { weekday: String(schedule.day) } : {}) };
}

export function composerTemplate(name: string | null): URLSearchParams {
  const picked = name === null ? null : templateByName(name);
  if (picked === null || picked.kind === "recipe") return new URLSearchParams();
  const fields = new URLSearchParams({ request: picked.goal, not: picked.outOfScope ?? "", touches: picked.touches.join(", "), template: picked.name });
  if (picked.kind === "routine") {
    const schedule = parseSchedule(picked.schedule);
    if (schedule !== null) for (const [key, value] of Object.entries(scheduleFields(schedule))) fields.set(key, value);
    if (picked.costCeilingUsd !== null) fields.set("ceiling", String(picked.costCeilingUsd));
  }
  return fields;
}

export function routineNameFromDescription(description: string): string {
  return description.split("\n", 1)[0]!.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 33).replace(/-+$/, "") || "recurring-task";
}
