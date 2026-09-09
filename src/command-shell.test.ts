import { describe, expect, test } from "vitest";
import { approvedCommandShell } from "./builder.js";

describe("operator-approved repository command shell", () => {
  test("uses cmd.exe without rewriting the approved command on Windows", () => {
    expect(approvedCommandShell("npm ci", "win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm ci"],
      display: "cmd.exe /d /s /c npm ci",
    });
  });

  test("uses /bin/sh without rewriting the approved command on POSIX", () => {
    expect(approvedCommandShell("npm ci", "linux")).toEqual({
      file: "/bin/sh",
      args: ["-c", "npm ci"],
      display: "sh -c npm ci",
    });
  });
});
