/** Who the lead is (Settings → Lead): the name a person gives their lead and the short persona it speaks with. The
 * name is what every chat, pushed update and status line calls the lead; the persona opens each turn's DATA. */
import type { Store } from "./store.js";

export const DEFAULT_LEAD_NAME = "Lead";
export const DEFAULT_LEAD_PERSONA = "Be genuinely helpful, not performative. Have opinions and say which you'd pick. Check before you claim. Be resourceful before asking. Keep it short.";
export const LEAD_NAME_MAX = 40;
export const LEAD_PERSONA_MAX = 600;

export type LeadIdentity = { name: string; persona: string };

/** This person's lead: their saved name and persona, else the defaults. An older store reads as the defaults. */
export function leadIdentityOf(store: Store, account: string | null | undefined): LeadIdentity {
  if (account == null || account === "") return { name: DEFAULT_LEAD_NAME, persona: DEFAULT_LEAD_PERSONA };
  try {
    const saved = store.leadConfig(account);
    if (saved !== null) return { name: saved.name || DEFAULT_LEAD_NAME, persona: saved.persona || DEFAULT_LEAD_PERSONA };
  } catch { /* no lead_config yet: the defaults */ }
  return { name: DEFAULT_LEAD_NAME, persona: DEFAULT_LEAD_PERSONA };
}

/** The name alone, for the places the lead speaks. */
export function leadNameOf(store: Store, account: string | null | undefined): string {
  return leadIdentityOf(store, account).name;
}

/** The saved form of a name and persona, or the problem with them. An empty name or persona means the default. */
export function checkLeadIdentity(name: string, persona: string): { ok: true; identity: LeadIdentity } | { ok: false; message: string } {
  const named = name.trim().replace(/\s+/g, " "), described = persona.trim().replace(/\r\n?/g, "\n");
  if (named.length > LEAD_NAME_MAX) return { ok: false, message: `Keep the name to ${LEAD_NAME_MAX} characters.` };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'’_-]*$/u.test(named) && named !== "") return { ok: false, message: "Use letters, numbers and spaces in the name." };
  if (described.length > LEAD_PERSONA_MAX) return { ok: false, message: `Keep the persona to ${LEAD_PERSONA_MAX} characters.` };
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(described)) return { ok: false, message: "Use plain text in the persona." };
  return { ok: true, identity: { name: named || DEFAULT_LEAD_NAME, persona: described || DEFAULT_LEAD_PERSONA } };
}
