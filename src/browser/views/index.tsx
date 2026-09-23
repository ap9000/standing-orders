/** Rebuilt pages: the view's kind picks the component. */
import type { BrowserView } from "../../browser-workspace.js";
import { ProjectsView } from "./projects-view.js";
import { ResultView } from "./result-view.js";
import { SettingsView } from "./settings-view.js";
import { TaskView } from "./task-view.js";
import { TasksView } from "./tasks-view.js";

export function ViewHost({ view, csrf }: { view: BrowserView; csrf: string }) {
  return <div data-view={view.kind} className="w-full">
    {view.kind === "tasks" ? <TasksView view={view} /> : view.kind === "settings" ? <SettingsView view={view} csrf={csrf} /> : view.kind === "task" ? <TaskView view={view} /> : view.kind === "projects" ? <ProjectsView view={view} csrf={csrf} /> : view.kind === "result" ? <ResultView view={view} csrf={csrf} /> : null}
  </div>;
}
