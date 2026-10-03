import { describe, expect, test, vi } from "vitest";
import {
  NOTHING_ATTACHED, deliverableClaim, dropDeliverableClaims, linkLabel, renderReply, replyHtmlInline, replyCarriesDeliverable,
  shapeReply, telegramReply, type ReplyChannel,
} from "./reply-shape.js";
import { warmTurn } from "./chat-warmth.js";

const ORIGIN = "https://so.example.com";
const CHANNELS: ReplyChannel[] = ["console", "terminal", "telegram", "slack", "discord", "teams"];

/** What a person sees on each channel: the console's HTML, Telegram's text with its entities, and the rest as sent. */
function seen(text: string, channel: ReplyChannel, asked?: string): { text: string; bold: string[]; links: Array<{ label: string; url: string }> } {
  const shaped = shapeReply(text, { appOrigin: ORIGIN, ...(asked === undefined ? {} : { asked }) });
  if (channel === "console") {
    const html = shaped.split("\n").map(replyHtmlInline).join("\n");
    return {
      text: html.replace(/<[^>]+>/g, ""),
      bold: [...html.matchAll(/<strong>(.*?)<\/strong>/g)].map(one => one[1]!),
      links: [...html.matchAll(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(one => ({ label: one[2]!, url: one[1]!.replaceAll("&amp;", "&") })),
    };
  }
  if (channel === "telegram") {
    const sent = telegramReply(shaped);
    const cut = (offset: number, length: number) => sent.text.slice(offset, offset + length);
    return {
      text: sent.text,
      bold: sent.entities.filter(one => one.type === "bold").map(one => cut(one.offset, one.length)),
      links: sent.entities.flatMap(one => one.type === "text_link" ? [{ label: cut(one.offset, one.length), url: one.url }] : []),
    };
  }
  const out = renderReply(shaped, channel);
  if (channel === "terminal") return { text: out, bold: [], links: [...out.matchAll(/(the task|the result|Settings → Lead|github\.com) \((https:[^)\s]+)\)/g)].map(one => ({ label: one[1]!, url: one[2]! })) };
  if (channel === "slack") return {
    text: out,
    bold: [...out.matchAll(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g)].map(one => one[1]!),
    links: [...out.matchAll(/<(https:[^|>]+)\|([^>]+)>/g)].map(one => ({ label: one[2]!, url: one[1]!.replaceAll("&amp;", "&") })),
  };
  return {
    text: out,
    bold: [...out.matchAll(/\*\*(.+?)\*\*/g)].map(one => one[1]!),
    links: [...out.matchAll(/\[((?:\\.|[^\]\\])+)\]\((https:[^)\s]+)\)/g)].map(one => ({ label: one[1]!.replace(/\\(.)/g, "$1"), url: one[2]! })),
  };
}

describe("one reply shaper, every channel", () => {
  describe.each(CHANNELS)("%s", channel => {
    test("Markdown headers become plain lines", () => {
      const shown = seen("## Status\nThe payout fix is ready.\n\nNext steps\n===\nOpen it when you can.", channel);
      expect(shown.text).not.toMatch(/#|===/);
      expect(shown.text).toContain("Status");
      expect(shown.text).toContain("Next steps");
      expect(shown.text).toContain("The payout fix is ready.");
    });

    test("bold stays on at most three short anchors", () => {
      const shown = seen("**Ready**: the **payout fix** passed **all checks**, and **the login page** is next. **This whole sentence is far too long to be a short anchor at all.**", channel);
      if (channel === "terminal") expect(shown.text).not.toContain("*");
      else expect(shown.bold).toEqual(["Ready", "payout fix", "all checks"]);
      expect(shown.text).toContain("the login page is next");
      expect(shown.text).toContain("This whole sentence is far too long to be a short anchor at all.");
    });

    test("bare URLs become labelled links, named from where they go", () => {
      const shown = seen(`The task: ${ORIGIN}/chat?task=payout. Its result: ${ORIGIN}/chat?task=payout&result=7, rename me at ${ORIGIN}/settings/lead and the PR is https://github.com/acme/app/pull/9.`, channel);
      expect(shown.links).toEqual([
        { label: "the task", url: `${ORIGIN}/chat?task=payout` },
        { label: "the result", url: `${ORIGIN}/chat?task=payout&result=7` },
        { label: "Settings → Lead", url: `${ORIGIN}/settings/lead` },
        { label: "github.com", url: "https://github.com/acme/app/pull/9" },
      ]);
      if (channel === "telegram" || channel === "console") expect(shown.text).not.toContain("https://");
    });

    test("internal ids are removed unless the owner asked for them", () => {
      const reply = `The payout fix (run #42) failed in r1. Digest ${"4f2a9c1b".repeat(4)} is stale, and run #43 is queued.`;
      const plain = seen(reply, channel);
      expect(plain.text).not.toMatch(/#4\d|r1\b|4f2a9c1b/);
      expect(plain.text).toContain("The payout fix failed in the project. The digest is stale, and the run is queued.");
      const asked = seen(reply, channel, "what's the run id and digest?");
      expect(asked.text).toMatch(/#42/);
      expect(asked.text).toContain("4f2a9c1b");
    });

    test("three or more blank lines collapse to one", () => {
      const shown = seen("The fix is ready.\n\n\n\n\nOpen it when you can.", channel);
      expect(shown.text).not.toMatch(/\n\s*\n\s*\n/);
      expect(shown.text).toMatch(/ready\.\n+Open it/);
    });
  });

  test("shaping never changes meaning: code is untouched, ordinary prose passes through, and shaping is idempotent", () => {
    const reply = "Run `git log r1 --grep=#42` to see it.\n\n- first\n- second\n\n```\n## not a header 4f2a9c1b4f2a9c1b\n```";
    expect(shapeReply(reply)).toBe(reply);
    const messy = `# Done\n**One** **two** **three** **four**, see ${ORIGIN}/t/abc (run #9).\n\n\n\nBye`;
    const once = shapeReply(messy, { appOrigin: ORIGIN });
    expect(shapeReply(once, { appOrigin: ORIGIN })).toBe(once);
    expect(shapeReply("I'll check the r2-d2 branch and version 1.2.")).toBe("I'll check the r2-d2 branch and version 1.2.");
    expect(shapeReply("Call bad() then retry (it is safe).")).toBe("Call bad() then retry (it is safe).");
  });

  test("only the app's own origin earns an app label: a foreign link always shows its real host, whatever the model called it", () => {
    const spoof = shapeReply("Open [the task](https://evil.example/chat?task=payout) or https://evil.example/settings/lead", { appOrigin: ORIGIN });
    expect(spoof).toBe("Open [evil.example](https://evil.example/chat?task=payout) or [evil.example](https://evil.example/settings/lead)");
    expect(shapeReply(`See ${ORIGIN}/chat?task=a`)).toBe(`See [so.example.com](${ORIGIN}/chat?task=a)`);
    expect(shapeReply(`See [the payout fix](${ORIGIN}/t/a)`, { appOrigin: ORIGIN })).toBe(`See [the payout fix](${ORIGIN}/t/a)`);
  });

  test("each channel escapes its own syntax around what the shaper keeps", () => {
    expect(renderReply(shapeReply("a <b> & c"), "slack")).toBe("a &lt;b&gt; &amp; c");
    expect(renderReply(shapeReply("use @here and _x_"), "discord")).toBe("use @​here and \\_x\\_");
    expect(replyHtmlInline(shapeReply(`<script>x</script> ${ORIGIN}/t/a"b`, { appOrigin: ORIGIN }))).not.toMatch(/<script>|"b"/);
    expect(linkLabel("not a url")).toBe("not a url");
  });
});

describe("deliverables", () => {
  test("a reply that says it is sending or attaching something is recognised", () => {
    for (const claim of ["Here's the screenshot.", "I've attached the log.", "I'm sending you the report now.", "Sending the file.", "The screenshots are attached.", "Here is a link to the result."])
      expect(deliverableClaim(claim), claim).not.toBeNull();
    for (const plain of ["Here's what the log shows: the build failed.", "Want me to send the screenshot?", "The report is ready to review.", "I can attach the log if you like."])
      expect(deliverableClaim(plain), plain).toBeNull();
  });
  test("a link or quoted content backs a claim; dropping a claim says so once and keeps the rest", () => {
    expect(replyCarriesDeliverable(`Here's the link: ${ORIGIN}/t/a`)).toBe(true);
    expect(replyCarriesDeliverable("Here's the log:\n```\nerror\n```")).toBe(true);
    expect(replyCarriesDeliverable("Here's the screenshot.")).toBe(false);
    expect(dropDeliverableClaims("Checks pass. Here's the screenshot. Here's the log.\nShip it?")).toBe(`Checks pass. ${NOTHING_ATTACHED}\nShip it?`);
    expect(dropDeliverableClaims("Here's the screenshot.")).toBe(NOTHING_ATTACHED);
  });
});

describe("warm touches", () => {
  test("the first tool step reacts once and starts typing, refreshed until the turn ends; a quick reply gets neither", async () => {
    vi.useFakeTimers();
    try {
      const react = vi.fn(async () => undefined), typing = vi.fn(async () => undefined);
      const quick = warmTurn({ react, typing });
      quick.onProgress({ kind: "started", turn: 1 });
      quick.onProgress({ kind: "step", turn: 1, step: 1 });
      quick.onProgress({ kind: "text", turn: 1, step: 1, text: "Hi" });
      quick.stop();
      expect(react).not.toHaveBeenCalled();
      expect(typing).not.toHaveBeenCalled();

      const slow = warmTurn({ react, typing }, { refreshMs: 1_000 });
      slow.onProgress({ kind: "step", turn: 2, step: 1 });
      slow.onProgress({ kind: "tool", turn: 2, step: 1, label: "Reading the task" });
      slow.onProgress({ kind: "tool", turn: 2, step: 2, label: "Reading the result" });
      expect(react).toHaveBeenCalledTimes(1);
      expect(typing).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(typing).toHaveBeenCalledTimes(3);
      slow.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(typing).toHaveBeenCalledTimes(3);
      expect(react).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  test("an app that refuses (no permission, no reactions) is skipped silently and never breaks the turn", async () => {
    const touches = warmTurn({ react: async () => { throw new Error("missing_scope"); }, typing: () => { throw new Error("boom"); } });
    expect(() => touches.onProgress({ kind: "tool", turn: 1, step: 1, label: "Listing tasks" })).not.toThrow();
    touches.stop();
    const none = warmTurn({});
    expect(() => none.onProgress({ kind: "tool", turn: 1, step: 1, label: "Listing tasks" })).not.toThrow();
    none.stop();
  });
});
