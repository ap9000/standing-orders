/** Shared privacy-preserving plain text for external conversations. */
import { scanForSecrets } from "./evidence.js";
export function publicChatText(value: string, cap: number): string {
  if (
    scanForSecrets(value).length > 0 ||
    /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/.test(value)
  )
    return "[sensitive text hidden]";
  const text = value
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, "[path]")
    .replace(
      /(^|[\s"'`(<[=:,])\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+/g,
      "$1[path]",
    )
    .replace(/\b[0-9a-f]{32,}\b/gi, "[digest]")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  // Keep surrogate pairs intact while bounding Telegram's UTF-16 ceiling.
  return text.length <= cap
    ? text
    : text.slice(0, cap - 2).replace(/[\uD800-\uDBFF]$/, "") + "…";
}
