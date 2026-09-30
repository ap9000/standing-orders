import { describe, expect, test } from "vitest";
import { shortWhen, whenHtml, whenUtc } from "./when-html.js";

describe("times on a phone", () => {
  const now = new Date("2026-09-30T17:10:00Z");

  test("today is the clock, yesterday and tomorrow say so, other days are a date", () => {
    expect(shortWhen("2026-09-30T16:39:12.000Z", now)).toBe("16:39");
    expect(shortWhen("2026-09-29T16:39:00Z", now)).toBe("Yesterday 16:39");
    expect(shortWhen("2026-10-01T08:05:00Z", now)).toBe("Tomorrow 08:05");
    expect(shortWhen("2026-09-28T23:59:00Z", now)).toBe("Sep 28");
    expect(shortWhen("2025-12-31T10:00:00Z", now)).toBe("Dec 31 2025");
    expect(shortWhen("not a time", now)).toBe("not a time");
  });

  test("the desk keeps the full stamp, and so does the title", () => {
    const html = whenUtc("2026-09-30T16:39:12.000Z", now);
    expect(html).toBe('<time datetime="2026-09-30T16:39:12.000Z" title="2026-09-30 16:39 UTC"><span class="so-when-full">2026-09-30 16:39 UTC</span><span class="so-when-short">16:39</span></time>');
    expect(whenHtml(null, "never", now)).toBe("");
    expect(whenHtml("2026-09-30T16:39:00Z", '<b>"', now)).toContain('title="&lt;b&gt;&quot;"');
  });
});
