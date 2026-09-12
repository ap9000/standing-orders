/** Bounded structural metadata for an event whose text may exceed the wire
 * cap. Long JSON strings become null in a small skeleton, but every escape
 * is still validated. JSON.parse proves the remaining structure. Unknown,
 * malformed or over-complex input never earns permission to discard it. */
export function jsonlDiscriminants(): {
  push(bytes: Buffer): void;
  finish(): { type: string; itemType: string | null } | null;
} {
  const skeleton = Buffer.allocUnsafe(64 * 1024);
  const token = Buffer.allocUnsafe(256);
  let size = 0;
  let tokenSize = 0;
  let longString = false;
  let inString = false;
  let escaped = false;
  let unicode = 0;
  let invalid = false;
  const emit = (byte: number): void => {
    if (size >= skeleton.length) invalid = true;
    else skeleton[size++] = byte;
  };
  const remember = (byte: number): void => {
    if (tokenSize < token.length) token[tokenSize++] = byte;
    else longString = true;
  };
  return {
    push(bytes): void {
      for (const byte of bytes) {
        if (invalid) return;
        if (!inString) {
          if (byte === 34) {
            inString = true;
            tokenSize = 0;
            longString = false;
            remember(byte);
          } else if (byte === 32 || byte === 9 || byte === 13) {
            if (size === 0 || skeleton[size - 1] !== 32) emit(32);
          } else emit(byte);
          continue;
        }
        remember(byte);
        if (unicode > 0) {
          if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) invalid = true;
          unicode--;
        } else if (escaped) {
          escaped = false;
          if (byte === 117) unicode = 4;
          else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) invalid = true;
        } else if (byte === 92) escaped = true;
        else if (byte === 34) {
          inString = false;
          // A long key also becomes null, which is invalid JSON: refuse
          // classification rather than invent a possibly colliding key.
          const value = longString ? Buffer.from("null") : token.subarray(0, tokenSize);
          for (const one of value) emit(one);
        } else if (byte < 32) invalid = true;
      }
    },
    finish() {
      if (invalid || inString) return null;
      try {
        const event: unknown = JSON.parse(skeleton.toString("utf8", 0, size));
        if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
        const { type, item } = event as Record<string, unknown>;
        if (typeof type !== "string") return null;
        const itemType = item !== null && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)["type"] : null;
        return { type, itemType: typeof itemType === "string" ? itemType : null };
      } catch { return null; }
    },
  };
}
