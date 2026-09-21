# Shared lead storage load probe

The synthetic team fixture kept conversation reads and message persistence small with 10,000 tasks. This is a storage and projection measurement on one central process, not a claim about remote browser latency or provider capacity.

Run `node --import tsx scripts/benchmark-team.ts` to create an isolated temporary SQLite database and write `output/team/load-report.json`. The script never opens production data, starts an agent turn or calls a model. It removes its temporary database afterward.

The 21 September 2026 run contained 20 people, 10 leads and team conversations, 100 projects, 10,000 tasks, 30,000 historical runs and 90,000 artifact metadata rows. The database was about 190 MB. Fifty logical clients shared those conversations. Each measurement used four sequential bursts of 50 operations, matching one central SQLite event loop; it did not create 50 independent network connections. Synthetic artifact files were deliberately absent to catch accidental artifact reads in metadata lists.

| Operation | Median | p95 | 50-operation burst |
| --- | ---: | ---: | ---: |
| Conversation snapshot | 1.49 ms | 2.23 ms | 86–88 ms |
| Authorized conversation cursor | 0.11 ms | 0.17 ms | 6–9 ms |
| Scoped lead task page, 40 rows | 40.49 ms | 72.81 ms | 1.9–2.7 s |
| Persist message and return snapshot | 2.46 ms | 5.12 ms | 131–142 ms |

The scoped page contained exactly 1,000 tasks across its lead's ten projects and returned 40 rows. No foreign project appeared. The probe saved messages without dispatching them; it recorded zero agent turns and zero model calls.

The cursor used for idle event streams is much cheaper than repeatedly rebuilding task pages. Fifty expensive task-page requests still accumulate seconds of event-loop work. Reuse scoped task projections and refresh only after a change; do not replace event hints with one full task scan per connected viewer. Conversation snapshots alone did not show a performance problem needing another cache or query redesign in this run.

Still unverified by this probe: HTTP authentication and delivery under 50 concurrent connections, browser rendering, independent-process write contention, network reconnects, provider throughput, and end-to-end status visibility. Domain timings do not establish the planned user-visible latency targets. The synthetic roles, authors and fixture content are not real team activity.
