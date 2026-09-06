import { test, expect } from "vitest";
import { parseSchedule, scheduleText, describeSchedule, firstFireAt, nextFireAt, routineDigestOf } from "./routine.js";
import { composerSchedule } from "./task-composer.js";

test.each([
  ["daily:09:00@America/Los_Angeles", "2026-03-07T18:00:00Z", "2026-03-08T16:00:00.000Z"],
  ["daily:09:00@America/Los_Angeles", "2026-10-31T17:00:00Z", "2026-11-01T17:00:00.000Z"],
  ["daily:02:30@America/Los_Angeles", "2026-03-08T00:00:00Z", "2026-03-09T09:30:00.000Z"],
  ["daily:01:30@America/Los_Angeles", "2026-11-01T07:00:00Z", "2026-11-01T08:30:00.000Z"],
  ["daily:01:30@America/Los_Angeles", "2026-11-01T08:30:00Z", "2026-11-02T09:30:00.000Z"],
  ["weekly:0:02:30@America/Los_Angeles", "2026-03-07T18:00:00Z", "2026-03-15T09:30:00.000Z"],
  ["weekly:1:09:00@America/Los_Angeles", "2026-09-05T22:00:00Z", "2026-09-07T16:00:00.000Z"],
  ["daily:09:00@Asia/Kolkata", "2026-09-05T02:00:00Z", "2026-09-05T03:30:00.000Z"],
  ["daily:09:00@Pacific/Auckland", "2026-09-05T02:00:00Z", "2026-09-05T21:00:00.000Z"],
  ["daily:03:30", "2026-09-05T03:30:00Z", "2026-09-06T03:30:00.000Z"],
])("%s fires once at the next valid wall-clock slot after %s", (text, now, expected) => {
  const schedule = parseSchedule(text)!; expect(schedule).not.toBeNull();
  expect(scheduleText(schedule)).toBe(text);
  expect(firstFireAt(schedule, new Date(now))).toBe(expected);
  expect(nextFireAt(schedule, "2025-01-01T00:00:00.000Z", new Date(now))).toBe(expected);
});

test("calendar parsing refuses invalid times, days, and timezones", () => {
  for (const text of ["weekly:7:09:00@UTC", "weekly:1:24:00@UTC", "daily:09:00@Mars/Olympus", "daily:09:00@", "weekly:1:09:00@UTC\n", "daily:9:00@UTC"]) expect(parseSchedule(text), text).toBeNull();
  expect(describeSchedule(parseSchedule("weekly:1:09:00@America/Los_Angeles")!)).toBe("every Monday at 09:00 America/Los_Angeles");
});

test("UI schedules validate on the server and bind timezone and weekday into approval terms", () => {
  const fields = new URLSearchParams({ repeat: "weekly", weekday: "1", time: "09:00", timezone: "America/Los_Angeles" });
  expect(composerSchedule(fields)).toEqual({ ok: true, schedule: "weekly:1:09:00@America/Los_Angeles" });
  const terms = { repo: "/repo", goal: "Check docs", outOfScope: null, touches: [], requirements: [], schedule: "weekly:1:09:00@America/Los_Angeles", singleFlight: true, costCeilingUsd: null };
  expect(routineDigestOf(terms)).not.toBe(routineDigestOf({ ...terms, schedule: "weekly:2:09:00@America/Los_Angeles" }));
  expect(routineDigestOf(terms)).not.toBe(routineDigestOf({ ...terms, schedule: "weekly:1:09:00@America/New_York" }));
  for (const [key, value] of [["repeat", "hourly"], ["weekday", "8"], ["time", "25:00"], ["timezone", "invalid"]]) {
    const bad = new URLSearchParams(fields); bad.set(key!, value!); expect(composerSchedule(bad).ok).toBe(false);
  }
  expect(composerSchedule(new URLSearchParams({ repeat: "custom", interval: "2", "interval-unit": "hours" }))).toEqual({ ok: true, schedule: "every:120" });
  expect(composerSchedule(new URLSearchParams({ repeat: "custom", interval: "4", "interval-unit": "minutes" })).ok).toBe(false);
  expect(composerSchedule(new URLSearchParams({ repeat: "custom", interval: "8", "interval-unit": "days" })).ok).toBe(false);
});
