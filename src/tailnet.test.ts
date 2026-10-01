import { expect, test } from "vitest";
import { readTailnetNames, tailnetNamesOf } from "./tailnet.js";

const status = (body: unknown) => JSON.stringify(body);

test("this computer's tailnet names: the full MagicDNS name, then its short form, only while Tailscale runs", () => {
  expect(tailnetNamesOf(status({ BackendState: "Running", Self: { DNSName: "Alex-Mac.tail1234.ts.net." } }))).toEqual(["alex-mac.tail1234.ts.net", "alex-mac"]);
  expect(tailnetNamesOf(status({ BackendState: "Stopped", Self: { DNSName: "alex-mac.tail1234.ts.net." } }))).toEqual([]);
  expect(tailnetNamesOf(status({ BackendState: "Running", Self: { DNSName: "bad name.ts.net." } }))).toEqual([]);
  expect(tailnetNamesOf("not json")).toEqual([]);
});

test("no Tailscale, or one that fails, is no tailnet", async () => {
  expect(await readTailnetNames(async () => ({ code: null, stdout: "", notFound: true }), "linux")).toEqual([]);
  expect(await readTailnetNames(async () => ({ code: 1, stdout: "" }), "linux")).toEqual([]);
  expect(await readTailnetNames(async () => { throw new Error("spawn failed"); }, "linux")).toEqual([]);
  expect(await readTailnetNames(async () => ({ code: 0, stdout: status({ BackendState: "Running", Self: { DNSName: "box.tail9.ts.net." } }) }), "linux")).toEqual(["box.tail9.ts.net", "box"]);
});
