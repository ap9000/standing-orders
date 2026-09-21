# Relevant code without another task gate

The lead and task crews can read a bounded selection of repository source alongside saved project knowledge. The database still owns goals, instructions, decisions and task status. The repository map is a disposable aid to finding code; it grants no authority, completes no work and does not change the required verification command.

```sh
standing-orders knowledge search "save session" --repo /absolute/project --json
standing-orders knowledge refresh --repo /absolute/project --json
standing-orders knowledge impact src/session.ts --repo /absolute/project --json
```

Search works before indexing. Refresh explicitly builds a local TypeScript/JavaScript symbol and import map. Impact follows reverse imports for up to two steps and returns source locations. Results explain whether they came from the map or ordinary source search. An ambiguous symbol requires an exact file path; it does not invent an impact path.

The CLI supports an explicit coordinator token file or environment-variable name. Those credentials constrain the project before source reading, and invalid or revoked credentials never fall back to local authority. Without a credential, these commands use the same local file-reading authority as other local reads. Refresh writes only the derived cache.

## Shared contract

`repositoryContextRead(request)` is synchronous and read-only for lead tools and provider-admission transactions. `repositoryContext(request)` provides the same response and supports explicit asynchronous `refresh: true`. The response includes the checkout, Git directory, HEAD, requested base, selected-source SHA-256 hashes, extractor version, index generation, cited excerpts, relationships and visible omissions. `source: working-tree` explicitly distinguishes current hashed bytes from committed file contents. The request's audience controls the bounded selection for lead or crew.

The initial map uses `typescript-parser`, a runtime alias pinned to TypeScript 6.0.3. It extracts named declarations, static imports, re-exports and literal dynamic imports. Module resolution understands root `tsconfig.json` path aliases. It does not claim complete runtime call graphs, package dependencies, inherited tsconfig settings or dynamic-expression imports. Unresolved imports and syntax errors remain visible. Impact is advisory and cannot establish that a particular test selection covers every consequence.

Reads cover tracked ordinary text files only, capped at 1,200 files, 256 KB per file and 12 MB in total. Symlinks, unreadable/sensitive files, generated/vendor directories and invalid text are excluded. A source selection carries file hashes and line locations; the response is byte-bounded. Source text is untrusted reference material, never a new instruction.

Every read hashes the selected current source set. A dirty change, deletion, moved HEAD, different base, different worktree, incompatible extractor or corrupt cache prevents reuse. Refresh replaces the complete bounded map atomically; this first implementation does not have a per-file AST cache. An interrupted write leaves the previous generation usable only when its identity still matches. Missing or stale mapping falls back to ordinary source search and file reading.

For task crews, the saved run worktree must belong to the admitted project's Git repository and its HEAD must match the task base at capture. A mismatch yields unavailable optional context instead of supplying another checkout's source. Builder and planner admission save the selection in the existing immutable knowledge snapshot, within its existing overall context budget. Resume reuses that exact saved selection after files change or disappear. No schema migration or new task gate is involved. Native interactive coding sessions retain their existing curated context lifecycle; this slice does not move their pre-worktree admission phase.

## Graphify evaluation and choice

The evaluation used the public Graphify v8 source at `20a20d30d8e7eef77675651f0199d87f913bd3e7` (package 0.9.65), installed only in a temporary isolated Python environment. It indexed synthetic fixtures only: four TypeScript files, a root alias configuration and a short README. The files exercised a named imported function, alias resolution, an ESM re-export and a literal dynamic import. No Graphify hooks, agent skill, model ingestion or external graph service were installed or invoked. No private repository source was supplied to Graphify.

| Observation on this machine | Native adapter | Graphify code-only |
| --- | --- | --- |
| Fixture import/re-export/dynamic-import relationships | All three expected file relationships, with source lines | Expected relationships present, plus symbol call/containment/config relationships |
| One observed cold native build / forced Graphify rebuild | 550 ms | 484 ms |
| One observed current-cache native read | 96 ms | Not measured |
| Installed dependency footprint | 24 MB parser alias | 118 MB environment, excluding the Python interpreter |
| Additional runtime | Existing Node runtime | Python and parser packages |
| Structured integration | Our typed versioned response | Graph JSON or Python functions; query CLI output is text |

These are small local observations, not a comparative benchmark or a claim that the native adapter is faster. Graphify emitted 14 nodes and 17 edges and supplied more relationship types. The native implementation was chosen for the narrower current TS/JS requirement and smaller deployment footprint. The existing TypeScript 7.0.2 build dependency exports a native compiler with an unstable service API, so its root package could not supply the previous in-process parser API. The pinned alias keeps the build compiler unchanged and avoids adopting a compiler service or Python environment merely for this slice.

Graphify remains a reasonable future adapter for polyglot repositories or richer relationships. Such an adapter should preserve this same context contract and fallback behavior, consume structured graph data, pin its dependency environment and exclude semantic model work unless separately configured. The evaluated public source is [Graphify 20a20d30](https://github.com/Graphify-Labs/graphify/tree/20a20d30d8e7eef77675651f0199d87f913bd3e7).

## Verification

Focused regressions cover real CLI refresh/search/impact parsing; coordinator scope and revocation; TS aliases, re-exports and dynamic imports; corrupt/missing/stale caches; changed and deleted sources; worktree and base isolation; ambiguous impact; source exclusion; bounded Unicode output; and immutable crew selections. Typecheck passed. The five context, knowledge, builder and planner suites passed 215 cases. An existing provider-brief regression caught a raw Unicode line separator in the repeated source query; rendering now escapes those separators while the saved source bytes stay exact. The final combined release verification is owned by the lead.
