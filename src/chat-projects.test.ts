import { test, expect } from "vitest";
import { encodeProjectMentions, decodeProjectMentions } from "./chat-projects.js";

test("names are readable locally and turn into stable project IDs for the model", () => {
  const repos = ["/private/work/Website", "/private/work/Mobile app"];
  expect(encodeProjectMentions("Fix website and Mobile app, not WebsiteBuilder.", repos)).toBe("Fix r1 and r2, not WebsiteBuilder.");
  expect(encodeProjectMentions("Fix /private/work/Website.", repos)).toBe("Fix r1.");
  expect(decodeProjectMentions("Which project: r1 or r2? r20 is unknown.", repos)).toBe("Which project: Website or Mobile app? r20 is unknown.");
});

test("duplicate folder names are never resolved to an arbitrary project", () => {
  expect(encodeProjectMentions("Fix app", ["/one/app", "/two/app"])).toBe("Fix app");
});
