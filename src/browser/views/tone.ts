/** The shared status tones as badge tones. Amber is only "a person is needed". */
import type { StatusTone } from "../../workspace-ui.js";
export type BadgeTone = "neutral" | "success" | "warning" | "attention" | "danger" | "info";
export function toneOf(tone: StatusTone): BadgeTone {
  switch (tone) {
    case "attention": return "attention";
    case "problem": return "danger";
    case "live": return "info";
    case "ready": case "done": return "success";
    default: return "neutral";
  }
}
