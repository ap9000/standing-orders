/**
 * Settings → Sign-in (v100): the identity provider this installation trusts,
 * kept in `sign-in.json` beside the database (0600) with its client secret,
 * never in the database. Group rules are ordered: a person's first matching
 * group sets their role and projects.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GroupRule, OidcSettings } from "./oidc.js";

const FILE = "sign-in.json";
export const SSO_CALLBACK = "/login/sso/callback";

const isAddress = (value: string) => {
  try { const url = new URL(value); return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)); } catch { return false; }
};

/** A name for the button from the issuer, when none is given. */
export function providerLabel(issuer: string): string {
  const host = (() => { try { return new URL(issuer).hostname; } catch { return ""; } })();
  return /okta\.com$|oktapreview\.com$/.test(host) ? "Okta" : /microsoftonline\.com$|microsoft\.com$/.test(host) ? "Microsoft"
    : /accounts\.google\.com$/.test(host) ? "Google" : /auth0\.com$/.test(host) ? "Auth0" : /jumpcloud\.com$/.test(host) ? "JumpCloud" : "your identity provider";
}

export function readSsoSettings(dir: string | null | undefined): OidcSettings | null {
  if (!dir) return null;
  const file = join(dir, FILE);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<OidcSettings>;
    if (typeof value.issuer !== "string" || typeof value.clientId !== "string" || !Array.isArray(value.rules)) return null;
    return {
      issuer: value.issuer, clientId: value.clientId, clientSecret: typeof value.clientSecret === "string" && value.clientSecret !== "" ? value.clientSecret : null,
      label: typeof value.label === "string" && value.label !== "" ? value.label : providerLabel(value.issuer),
      scopes: typeof value.scopes === "string" && value.scopes !== "" ? value.scopes : "openid email profile",
      groupsClaim: typeof value.groupsClaim === "string" && value.groupsClaim !== "" ? value.groupsClaim : "groups",
      rules: value.rules.filter((rule): rule is GroupRule => rule !== null && typeof rule === "object" && typeof rule.group === "string" && (rule.role === "operator" || rule.role === "viewer")
        && (rule.projects === "all" || (Array.isArray(rule.projects) && rule.projects.every(one => typeof one === "string")))),
      passwords: value.passwords === "operators" ? "operators" : "everyone",
    };
  } catch {
    return null;
  }
}

/**
 * Save what the form sent. The client secret is kept when the field is left
 * blank; rules come as rows (group, role, projects), blank groups dropped.
 * `projects` for a row is "all" or the project paths chosen.
 */
export function saveSsoSettings(dir: string, form: { issuer: string; clientId: string; clientSecret: string; label: string; scopes: string; groupsClaim: string; passwords: string;
  rules: { group: string; role: string; projects: string[] }[] }, previous: OidcSettings | null): { ok: true; settings: OidcSettings } | { ok: false; said: string } {
  const issuer = form.issuer.trim().replace(/\/+$/, "");
  if (!isAddress(issuer)) return { ok: false, said: "The issuer is the provider's https address, like https://acme.okta.com/oauth2/default." };
  const clientId = form.clientId.trim();
  if (clientId === "" || clientId.length > 200) return { ok: false, said: "Enter the client ID the provider gave this app." };
  const secret = form.clientSecret.trim() === "" ? previous?.clientSecret ?? null : form.clientSecret.trim();
  const rules: GroupRule[] = [];
  for (const row of form.rules) {
    const group = row.group.trim();
    if (group === "") continue;
    if (group.length > 200) return { ok: false, said: "A group name is 200 characters at most." };
    if (row.role !== "operator" && row.role !== "viewer") return { ok: false, said: "Choose Operator or Viewer for each group." };
    const projects = row.projects.includes("all") || row.projects.length === 0 && row.role === "operator" ? "all" as const : row.projects;
    rules.push({ group, role: row.role, projects });
  }
  if (rules.length === 0) return { ok: false, said: "Add at least one group, so someone can sign in." };
  const scopes = form.scopes.trim() || "openid email profile";
  if (!scopes.split(/\s+/).includes("openid")) return { ok: false, said: "The scopes need openid." };
  const settings: OidcSettings = {
    issuer, clientId, clientSecret: secret, label: form.label.trim().slice(0, 40) || providerLabel(issuer), scopes,
    groupsClaim: form.groupsClaim.trim() || "groups", rules, passwords: form.passwords === "operators" ? "operators" : "everyone",
  };
  const file = join(dir, FILE);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { ok: true, settings };
}

export function removeSsoSettings(dir: string): void {
  rmSync(join(dir, FILE), { force: true });
}

/** What changed, for the ledger: never the secret itself, only that it changed. */
export function ssoChangeWords(before: OidcSettings | null, after: OidcSettings | null): string {
  const rules = (settings: OidcSettings) => settings.rules.map(rule => `${rule.group}: ${rule.role}${rule.projects === "all" ? ", all projects" : rule.projects.length === 0 ? ", no projects" : `, ${rule.projects.length} project${rule.projects.length === 1 ? "" : "s"}`}`).join("; ");
  const words = (settings: OidcSettings | null) => settings === null ? "off" : `${settings.label} (${settings.issuer}) · ${rules(settings)} · passwords: ${settings.passwords}`;
  const secretChanged = before !== null && after !== null && before.clientSecret !== after.clientSecret ? " · client secret replaced" : "";
  return `${words(before)} → ${words(after)}${secretChanged}`;
}
