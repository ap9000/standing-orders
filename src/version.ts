import { readFileSync } from "node:fs";

/** The package's own version, read from package.json beside dist/ or src/ — one source, never a literal. */
export const PACKAGE_VERSION: string = (() => {
  try {
    return String((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();
