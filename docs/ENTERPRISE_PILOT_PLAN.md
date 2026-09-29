# Enterprise pilot plan

Goal: a mid-size engineering organisation can run a self-hosted pilot of
Standing Orders in one team and pass its security review. The pitch: every
AI change comes with an audit-ready record, under your sign-in and your
approval rules.

Assessment (2026-09-27): approvals bound to exact terms, write-once
evidence, the action ledger, project roles and the agent fence already
exist. Missing: standard sign-in, separation of duties, a tamper-evident and
streamed audit trail, cost guardrails, machine-readable telemetry, and data
retention.

Each sprint ships as its own release through the usual gate. Sprint 1 is
PR #91 (schema 99); sprint 2 is PR #92 (schema 100); sprint 3 is PR #95
(schema 101); sprint 4 is PR #96 (schema 102); sprint 5 is PR #98
(schema 103); sprint 6 is PR #100 (schema 104); sprint 7 is PR #101
(schema 105).

| Sprint | Theme | Ships |
|---|---|---|
| 1 | Hardening quick wins | Sign-in throttling and lockout (browser and token), always-on error logging and JSON logs, `/healthz`, ledger v99 (Sign-in and Policy events with before → after), agent credentials revoked with the person who made them, more key shapes redacted |
| 2 | Single sign-on | OpenID Connect sign-in (Okta, Entra, Google), identity-provider groups → role and projects, accounts made on first sign-in, passwords optional |
| 3 | Credentials and sessions | Scoped, expiring API tokens instead of passwords on requests; sessions that survive restarts, listed and revocable; runner and coordinator credentials expire |
| 4 | Separation of duties | Who filed each task is recorded; per-project rule that the approver isn't the requester; two approvers for protected projects or paths; AI teammates can't decide protected approvals |
| 5 | Audit you can prove | Tamper-evident ledger (hash chain + verify command); teammate tool calls, modes and coordinator events in it; a change evidence pack per task (JSON + printable) |
| 6 | Stream it out | Audit events to the customer's log system (signed webhook, JSONL); OpenTelemetry traces per run; `/metrics` |
| 7 | Cost guardrails | Budgets per project, person and teammate with 50/80/100 % alerts and a hard stop on API work; every provider priced (subscription work is $0, its plan windows shown on Tasks); a spend page with CSV |
| 8 | Policy and data | Organisation policy (allowed providers, models, tools, permission ceiling) with history; retention settings, backup and restore, full export, project deletion |

Later: SAML and SCIM, two-factor for local accounts, encryption at rest and a
secrets vault, containerised runners, high availability.
