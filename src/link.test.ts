import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, lstat, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseTarget, planLink, applyLink, planUnlink, applyUnlink, BIN_NAME } from "./link.js";

const HOME = "/Users/someone";

describe("chooseTarget", () => {
  test("prefers ~/.local/bin when it is already on PATH", () => {
    const choice = chooseTarget({
      pathEntries: ["/usr/bin", join(HOME, ".local", "bin")],
      home: HOME,
    });

    expect(choice).toEqual({ dir: join(HOME, ".local", "bin"), onPath: true });
  });

  test("honours an explicit directory", () => {
    const choice = chooseTarget({
      pathEntries: ["/usr/bin"],
      home: HOME,
      override: "/opt/tools",
    });

    expect(choice.dir).toBe("/opt/tools");
    expect(choice.onPath).toBe(false);
  });

  test("never proposes a directory outside the home directory", () => {
    // Anything else would need sudo, and this command must never need sudo.
    const choice = chooseTarget({
      pathEntries: ["/usr/local/bin", "/usr/bin", "/bin"],
      home: HOME,
    });

    expect(choice.dir.startsWith(HOME)).toBe(true);
  });

  test("falls back to ~/.local/bin and reports that it is not on PATH", () => {
    const choice = chooseTarget({ pathEntries: ["/usr/bin"], home: HOME });

    expect(choice).toEqual({ dir: join(HOME, ".local", "bin"), onPath: false });
  });

  test("uses any home-owned PATH entry before inventing one", () => {
    const choice = chooseTarget({
      pathEntries: ["/usr/bin", join(HOME, "tools")],
      home: HOME,
    });

    expect(choice).toEqual({ dir: join(HOME, "tools"), onPath: true });
  });
});

describe("planLink and applyLink", () => {
  let base: string;
  let bin: string;
  let source: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "nightorders-link-"));
    bin = join(base, "bin");
    source = join(base, "cli.js");
    await mkdir(bin, { recursive: true });
    await writeFile(source, "#!/usr/bin/env node\n");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("plans to create a link when nothing is there", async () => {
    const plan = await planLink(source, bin);

    expect(plan.action).toBe("create");
    expect(plan.target).toBe(join(bin, BIN_NAME));
  });

  test("creates the link, and the directory if it does not exist", async () => {
    const fresh = join(base, "new", "bin");

    const plan = await planLink(source, fresh);
    await applyLink(plan);

    expect(await readlink(join(fresh, BIN_NAME))).toBe(source);
  });

  test("makes the linked command executable", async () => {
    // tsc does not set the execute bit, so a bare symlink to its output gives
    // "permission denied" the first time anyone types the command.
    const plan = await planLink(source, bin);

    await applyLink(plan);

    const mode = (await lstat(source)).mode;
    expect(mode & 0o100).toBeTruthy();
  });

  test("recognises a link it has already made", async () => {
    await symlink(source, join(bin, BIN_NAME));

    const plan = await planLink(source, bin);

    expect(plan.action).toBe("already");
  });

  test("replaces its own link when it points somewhere stale", async () => {
    await symlink(join(base, "old-cli.js"), join(bin, BIN_NAME));

    const plan = await planLink(source, bin);
    expect(plan.action).toBe("replace");

    await applyLink(plan);
    expect(await readlink(join(bin, BIN_NAME))).toBe(source);
  });

  test("refuses to touch a real file that is already there", async () => {
    // Someone else's binary of the same name is not ours to delete.
    const occupied = join(bin, BIN_NAME);
    await writeFile(occupied, "someone else's program\n");

    const plan = await planLink(source, bin);
    expect(plan.action).toBe("conflict");

    await expect(applyLink(plan)).rejects.toThrow();
    // and it is still there, untouched
    expect((await lstat(occupied)).isFile()).toBe(true);
  });
});

describe("planUnlink and applyUnlink", () => {
  let base: string;
  let bin: string;
  let source: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "nightorders-unlink-"));
    bin = join(base, "bin");
    source = join(base, "cli.js");
    await mkdir(bin, { recursive: true });
    await writeFile(source, "#!/usr/bin/env node\n");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("removes a link it made", async () => {
    await symlink(source, join(bin, BIN_NAME));

    const plan = await planUnlink(bin);
    expect(plan.action).toBe("remove");

    await applyUnlink(plan);
    await expect(lstat(join(bin, BIN_NAME))).rejects.toThrow();
  });

  test("says nothing is there when nothing is", async () => {
    const plan = await planUnlink(bin);

    expect(plan.action).toBe("absent");
  });

  test("refuses to remove a real file wearing the same name", async () => {
    const occupied = join(bin, BIN_NAME);
    await writeFile(occupied, "someone else's program\n");

    const plan = await planUnlink(bin);
    expect(plan.action).toBe("foreign");

    await expect(applyUnlink(plan)).rejects.toThrow();
    expect((await lstat(occupied)).isFile()).toBe(true);
  });
});
