/**
 * How much evidence work a task asks Standing Orders to do after the
 * builder finishes. This is deliberately separate from operating modes
 * (authority/autonomy) and unattended permissions (provider sandboxing).
 */
export type QualityMode = "default" | "strict";

export function isQualityMode(value: unknown): value is QualityMode {
  return value === "default" || value === "strict";
}

export function qualityModeTitle(mode: QualityMode): string {
  return mode === "strict" ? "Strict / release" : "Default";
}
