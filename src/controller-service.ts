/** Service entry for CLI controllers; the engine remains the watch child. */
import { superviseController } from "./controller-supervisor.js";
const [file, ...argv] = process.argv.slice(2);
if (!file) throw new Error("Controller service needs an executable.");
const stopping = new AbortController();
const stop = (): void => stopping.abort();
process.on("SIGTERM", stop); process.on("SIGINT", stop);
try {
  await superviseController({ file, argv, signal: stopping.signal, onState: state => {
    if (state.phase === "backoff") process.stderr.write(`Controller exited (${state.exit?.signal ?? state.exit?.code ?? "unknown"}); restart in ${state.retryMs} ms.\n`);
  } });
} finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
