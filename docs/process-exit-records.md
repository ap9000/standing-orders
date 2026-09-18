# Recording verified process exits

A Discord installation was blocked by an old process record for run1772,
row72698/PID4682. It was observed at 03:46:59 UTC on September18; that numeric
PID later belonged to Apple's MobileAsset DownloadService, born at03:53:28,
before the run finished at04:03:41. The existing conservative birth check
correctly refused to assume a delayed spawn was unrelated. No process was
killed or history cleared to make installation proceed.

The missing step was retaining positive exit observations. Descendant tracking
remembered every PID it saw, but ordinary completion usually left those records
without an exit time. A later reuse could therefore invalidate an otherwise
idle update.

The worker now records a descendant's exit while its root is still running.
A complete process snapshot must lack both the PID and its recorded process
group, followed by signal-zero probes proving absence. Reparenting, root exit,
age, permission errors and unreadable snapshots do not establish exit. The
store independently checks the OS evidence and compares the saved custody
fields before adding an exit timestamp. Native containers still require their
own empty proof; a verified boot change retains its existing meaning.

Completed commands and runs also save positive exit observations. Rows, process
identities and task outcomes remain intact. A process number seen again after
its recorded exit creates a fresh witness, including a stronger group witness
if a child later becomes a group leader. Saved identifiers never authorize a
termination signal. No schema or user permission changes are needed.

The regression covers exit followed by PID reuse before the builder finishes,
live and orphan groups, denied/unknown probes, failed snapshots, foreign hosts,
incomplete reservations and native objects, and real command completion. The
private-database sample exercises historical reconciliation without writing to
production. Current hashes, logs and sample results are in
`evidence/process-exits/2026-09-17`.

A process reused between observations can still be uncertain. Old rows without
positive exit proof retain the existing conservative rules; this change does
not invent missing historical identity. Installation must repeat normal drain,
backup, compatibility, process-exit and health checks on the verified build.
