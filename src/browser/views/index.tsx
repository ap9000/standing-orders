/** Rebuilt pages: the view's kind picks the component. */
import type { BrowserView } from "../../browser-workspace.js";
import { SettingsView } from "./settings-view.js";
import { TasksView } from "./tasks-view.js";

export function ViewHost({ view, csrf }: { view: BrowserView; csrf: string }) {
  return <div data-view={view.kind} className="w-full">
    {view.kind === "tasks" ? <TasksView view={view} /> : view.kind === "settings" ? <SettingsView view={view} csrf={csrf} /> : null}
  </div>;
}
