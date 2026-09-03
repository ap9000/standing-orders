import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";

const T0 = new Date("2026-09-03T00:00:00.000Z");

describe("runner register --token-file (setup review)", () => {
  let dir: string;
  let db: string;
  let lines: string[] = [];
  const run = (argv: string[]) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: T0 });
  };
  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-register-"));
    db = join(dir, "queue.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes the token owner-only to the file and never prints it; a second mint refuses to overwrite", async () => {
    await run(["approver", "add", "alex", "--json"]);
    const password = payload().token as string;
    const file = join(dir, "runner-token");
    const code = await run(["runner", "register", "w-1", "--repo", dir, "--as", "alex", "--token", password, "--token-file", file, "--json"]);
    expect(code).toBe(EXIT.ok);
    const said = payload();
    expect(said.ok).toBe(true);
    expect(said.token).toBeUndefined();
    expect(said.tokenFile).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(file, "utf8").trim();
    expect(token.length).toBeGreaterThan(16);
    expect(lines.join("\n")).not.toContain(token);

    const again = await run(["runner", "register", "w-2", "--repo", dir, "--as", "alex", "--token", password, "--token-file", file, "--json"]);
    expect(again).toBe(EXIT.refused);
    expect(payload().reason).toBe("token-file-exists");
    expect(readFileSync(file, "utf8").trim()).toBe(token);
    expect(existsSync(file)).toBe(true);
  });
});
