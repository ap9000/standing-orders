import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RELEASE_ID = 'com.standing-orders.desktop';
export const DEVELOPMENT_ID = RELEASE_ID + '.development';

/** Release builds never silently fall back to Sign to Run Locally. */
export function desktopBuildOptions(argv, env, home, artifactRoot = resolve('output', 'desktop')) {
  let destination, development = false, identity = env.STANDING_ORDERS_SIGN_IDENTITY;
  let notaryProfile = env.STANDING_ORDERS_NOTARY_PROFILE, upgradeFrom;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--development') development = true;
    else if (arg === '--sign-identity' || arg === '--notary-profile' || arg === '--upgrade-from') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw Error(`${arg} needs a value.`);
      if (arg === '--sign-identity') identity = value;
      else if (arg === '--notary-profile') notaryProfile = value;
      else upgradeFrom = resolve(value);
    } else if (arg.startsWith('-') || destination) throw Error(`Unexpected build argument: ${arg}`);
    else destination = resolve(arg);
  }
  if (development) {
    if (!destination) throw Error('--development needs an explicit preview destination; it never defaults to the installed app.');
    if (identity || notaryProfile || upgradeFrom) throw Error('Choose a development preview or a signed release, not both.');
  } else if (!identity || identity === '-') {
    throw Error('A release needs --sign-identity "Developer ID Application: …" (or STANDING_ORDERS_SIGN_IDENTITY). No valid identity? Use --development with a separate preview destination. Ad-hoc signing can reset macOS access grants.');
  }
  return { destination: destination ?? join(artifactRoot, randomUUID(), 'Standing Orders.app'), development, identity: development ? '-' : identity, notaryProfile,
    upgradeFrom: development ? undefined : upgradeFrom ?? join(home, 'Applications', 'Standing Orders.app'), explicitUpgradeFrom: upgradeFrom !== undefined,
    bundleId: development ? DEVELOPMENT_ID : RELEASE_ID, name: development ? 'Standing Orders Development' : 'Standing Orders' };
}

export function resolveReleaseIdentity(requested, listing) {
  const identities = [...listing.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(Developer ID Application: [^"\r\n]+)"\s*$/gm)]
    .map(match => ({ hash: match[1], name: match[2] }));
  const matching = identities.filter(one => one.hash.toLowerCase() === requested.toLowerCase() || one.name === requested);
  if (matching.length !== 1) throw Error('No unique, valid Developer ID Application identity matches. Unlock the signing keychain or install the release certificate; no ad-hoc fallback was used.');
  return matching[0].hash;
}

export function signingFacts(details) {
  return { bundleId: /^Identifier=(.+)$/m.exec(details)?.[1] ?? null,
    team: /^TeamIdentifier=(?!not set$)(.+)$/m.exec(details)?.[1] ?? null,
    adhoc: /^Signature=adhoc$/m.test(details) };
}

export function assertCompatibleUpgrade(previous, next, development) {
  if (previous.bundleId !== next.bundleId) throw Error('Refusing to replace an app with a different bundle identity. Development previews must use a separate destination.');
  if (development && previous.bundleId !== DEVELOPMENT_ID) throw Error('A development preview cannot replace the installed release.');
  if (!development && (!next.team || next.adhoc)) throw Error('The release does not have a stable team signing identity.');
  if (previous.team && previous.team !== next.team) throw Error('The signing team changed; refusing an update that could reset saved access.');
}
