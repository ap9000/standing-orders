import { test, expect } from "vitest";
import { resolve } from "node:path";
import { desktopBuildOptions, resolveReleaseIdentity, signingFacts, assertCompatibleUpgrade, DEVELOPMENT_ID, RELEASE_ID } from "../scripts/desktop-signing.mjs";

const name = "Developer ID Application: Fixture (ABCDEFGHIJ)";
const hash = "a".repeat(40);
const listing = `  1) ${hash} "${name}"\n  1 valid identities found\n`;

test("desktop releases refuse implicit ad-hoc signing before building or replacing anything", () => {
  expect(() => desktopBuildOptions([], {}, "/home/fixture")).toThrow(/release needs/);
  expect(() => desktopBuildOptions(["--sign-identity", "-"], {}, "/home/fixture")).toThrow(/release needs/);
  expect(() => desktopBuildOptions(["--unknown"], {}, "/home/fixture")).toThrow(/Unexpected/);
  expect(() => desktopBuildOptions(["--sign-identity"], {}, "/home/fixture")).toThrow(/needs a value/);
});

test("signed releases support explicit identity and Keychain notarization profile without raw credentials", () => {
  const options = desktopBuildOptions(["/tmp/Release.app", "--sign-identity", name, "--notary-profile", "release"], {}, "/home/fixture");
  expect(options).toMatchObject({ destination: resolve("/tmp/Release.app"), identity: name, notaryProfile: "release", bundleId: RELEASE_ID, development: false });
  expect(desktopBuildOptions([], { STANDING_ORDERS_SIGN_IDENTITY: name }, "/home/fixture").identity).toBe(name);
  const first = desktopBuildOptions([], { STANDING_ORDERS_SIGN_IDENTITY: name }, "/home/fixture", "/artifacts");
  const second = desktopBuildOptions([], { STANDING_ORDERS_SIGN_IDENTITY: name }, "/home/fixture", "/artifacts");
  expect(first.destination).not.toBe(second.destination);
  expect(first.destination.replaceAll("\\", "/")).toContain("/artifacts/");
  expect(first.destination).not.toBe(first.upgradeFrom);
  expect(first.upgradeFrom.replaceAll("\\", "/")).toBe("/home/fixture/Applications/Standing Orders.app");
  expect(desktopBuildOptions(["--upgrade-from", "/custom/Installed.app"], { STANDING_ORDERS_SIGN_IDENTITY: name }, "/home/fixture")).toMatchObject({ upgradeFrom: resolve("/custom/Installed.app"), explicitUpgradeFrom: true });
  expect(resolveReleaseIdentity(name, listing)).toBe(hash);
  expect(resolveReleaseIdentity(hash.toUpperCase(), listing)).toBe(hash);
  expect(() => resolveReleaseIdentity(name, "0 valid identities found")).toThrow(/no ad-hoc fallback/);
  expect(() => resolveReleaseIdentity("Apple Development: Fixture", listing)).toThrow(/No unique/);
  expect(() => resolveReleaseIdentity(name, listing + `2) ${"b".repeat(40)} "${name}"`)).toThrow(/No unique/);
});

test("development previews require explicit destinations and have separate identities", () => {
  expect(() => desktopBuildOptions(["--development"], {}, "/home/fixture")).toThrow(/explicit preview destination/);
  expect(() => desktopBuildOptions(["--development", "/tmp/Preview.app", "--sign-identity", name], {}, "/home/fixture")).toThrow(/not both/);
  const options = desktopBuildOptions(["--development", "/tmp/Preview.app"], {}, "/home/fixture");
  expect(options).toMatchObject({ identity: "-", bundleId: DEVELOPMENT_ID, development: true });
  expect(() => assertCompatibleUpgrade({bundleId:RELEASE_ID,team:"ABCDEFGHIJ",adhoc:false}, {bundleId:DEVELOPMENT_ID,team:null,adhoc:true}, true)).toThrow(/different bundle/);
});

test("updates preserve the signing team; the legacy ad-hoc migration is explicit in the release output", () => {
  const old = signingFacts("Identifier=com.standing-orders.desktop\nSignature=adhoc\nTeamIdentifier=not set\n");
  const next = {bundleId:RELEASE_ID,team:"ABCDEFGHIJ",adhoc:false};
  expect(old).toEqual({bundleId:RELEASE_ID,team:null,adhoc:true});
  expect(() => assertCompatibleUpgrade(old,next,false)).not.toThrow();
  expect(() => assertCompatibleUpgrade(next,next,false)).not.toThrow();
  expect(() => assertCompatibleUpgrade(next,{...next,team:"OTHERTEAM1"},false)).toThrow(/team changed/);
  expect(() => assertCompatibleUpgrade(next,old,false)).toThrow(/stable team/);
});
