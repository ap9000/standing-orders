/** Fixed destinations only. A model cannot supply a URL or an executable action.
 * These open the existing authenticated controls, never grant their authority.
 */
export const CHAT_CONTROLS = {
  task: { label: "Open task", target: "task" },
  approval: { label: "Review & start", target: "task" },
  planning: { label: "Review plan", target: "task" },
  recovery: { label: "Review recovery options", target: "task" },
  cancel: { label: "Cancel task", target: "task" },
  result: { label: "Review result", target: "task" },
  publish: { label: "Review publication", target: "task" },
  projects: { label: "Manage projects", href: "/projects" },
  routines: { label: "Manage routines", href: "/routines" },
  recipes: { label: "Browse workflows", href: "/recipes" },
  workers: { label: "Manage workers", href: "/fleet" },
  settings: { label: "Open settings", href: "/settings" },
  permissions: { label: "Review permissions", href: "/settings" },
  providers: { label: "Connect an agent", href: "/settings#providers" },
  knowledge: { label: "Edit project knowledge", href: "/settings/knowledge" },
  learning: { label: "Review learning history", href: "/settings/learning" },
  mode: { label: "Review automatic approvals", href: "/mode" },
} as const;
export type ChatControl = keyof typeof CHAT_CONTROLS;
export function isChatControl(value: unknown): value is ChatControl {
  return typeof value === "string" && Object.hasOwn(CHAT_CONTROLS, value);
}
export function chatControlHref(control: ChatControl, task: string): string {
  const entry = CHAT_CONTROLS[control];
  if ("href" in entry) return entry.href;
  const base = "/chat?task=" + encodeURIComponent(task);
  // Task details owns cancel, retry, publication and other dedicated ceremonies.
  if (control === "cancel" || control === "recovery" || control === "publish") return "/t/" + encodeURIComponent(task);
  return base + (control === "approval" || control === "planning" ? "#task-chat-action" : "");
}
