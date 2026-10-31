# Closing Bell

**A serverless pipeline that emails every client a signed PDF contract note after the trading session closes, built to run on a laptop and deploy to AWS.**

> Status: 🚧 design complete, implementation starting. See [Roadmap](#roadmap).
>
> Design docs: [High-level design](docs/HLD.md) (requirements, decisions, trade-offs) · [Architecture](docs/ARCHITECTURE.md) (services, workflow, storage, data contracts)

---

## The problem

Indian stockbrokers must send every client who traded that day a signed **contract note** (a legal record of the trades and charges), by email, the same evening.

| | At a large broker | This repo, locally |
|---|---|---|
| Clients who traded today | ~2,000,000 | 50,000 – 100,000 (synthetic) |
| Trade rows to read | ~10,000,000 | ~500,000 |
| Delivery window | 16:00 → 24:00 IST | — |
| Load the rest of the day | zero | — |

For a few thousand users this is a cron job and a loop. At two million it is a different problem:

- The load is **huge for an hour or two, then nothing for ~16 hours**.
- Nobody waits on a response, so latency doesn't matter. Bursts do.
- The trading database must not be hurt by the fan-out.
- A retry must **never** send a client a second email.
- Someone has to know, precisely, when the evening's run is finished and who didn't get a note.

That load shape (bursty, predictable, batch) is why this design uses serverless.

---

## Architecture

```
                     ┌─────────────── STEP FUNCTIONS: contract-notes-daily ───────────────┐
                     │                                                                    │
 EventBridge ─start─►│ [1] Extract ──► [2] Build ──► [3] Distributed Map ──► [4] Wrap-up  │
 (recon.completed    │  Fargate ×8     manifest      1 PDF Lambda per        Lambda       │
  event, or cron)    │  by user range                batch file, max N       bulk status  │
                     │                               at once, retries        + alert ops  │
                     └─────┬──────────────┬────────────────┬──────────────────────┬───────┘
                           │ reads chunks │ writes         │ batch in / PDF out   │ bulk COPY
                           ▼              ▼                ▼          │ send      ▼
                  Postgres READ     S3: batches/      S3: notes/      ▼     Postgres PRIMARY
                  REPLICA           S3: manifest      {user}.pdf     SES    note_status
                                                                           
                                                      DynamoDB note_sent
                                                      (idempotency keys)

 USER PATH (any time later):
   App ──► Backend API ──► note_status (Postgres) ──► presigned S3 URL ──► app downloads PDF
```

Horizontal arrows are **control flow** (Step Functions runs the steps in order). Vertical arrows are **data**.

### One evening, step by step

| # | Step | What happens |
|---|---|---|
| 0 | Reconcile | Exchange trade files are reconciled into Postgres. The pipeline waits; notes from unreconciled trades would have to be reissued. |
| 1 | Trigger | `recon.completed` on EventBridge starts one execution with `{ "tradeDate": "2026-10-16" }`, named `notes-2026-10-16`. A second start for the same date is rejected. |
| 2 | Extract | 8 parallel extractors, each owning a user-ID range, stream from the **read replica** with keyset pagination and write one file per 1,000 users to `batches/<date>/batch-NNNN.json`. Each file carries the users' emails, trades and charges. |
| 3 | Manifest | All batch files are listed in `manifest.json`: the day's to-do list and an audit record. |
| 4 | Fan-out | Distributed Map starts one PDF Lambda per batch file, at most **N** at once. |
| 5 | PDF Lambda | Per user: claim idempotency key → render PDF → sign → upload to `notes/<date>/<userId>.pdf` → email with the PDF attached. Returns `{ sent, failed[] }`. **Never touches Postgres.** |
| 6 | Retries | Failed batches are retried with backoff; already-handled users skip via their key. Per-user failures (e.g. a bad address) are reported, not retried forever. |
| 7 | Wrap-up | One Lambda collects every batch summary, bulk-`COPY`s statuses into `note_status`, marks the day complete and alerts ops with the failure count. |
| 8 | User | The app asks the backend for a note; the backend returns a short-lived presigned S3 URL. |

---

## Key design decisions

1. **Read once, write once.** One bulk read from a replica before the fan-out, one bulk write after it. The PDF workers never open a database connection, so Postgres sees 8 readers and 1 writer instead of thousands of connections.
2. **The work item carries its data.** A batch file contains everything a worker needs. The naive alternative ("process user 42", then query Postgres) is two million queries in a burst.
3. **Limits set the numbers.** Batch size comes from Lambda's 15-minute cap; concurrency **N** comes from the email provider's send quota. Neither is guessed.
4. **An orchestrator, not just events.** S3 events → SQS → Lambda has no notion of "everything is done". Step Functions waits for every Map child, which is what makes the wrap-up, audit and alert possible.
5. **Idempotency keys everywhere retries exist.** Every retry path here is at-least-once. A conditional write on `userId#tradeDate` in DynamoDB is claimed before sending, so a replayed batch skips users who were already handled.
6. **The trade date is an input, never "today".** A rerun the next morning processes the right day, and the execution name makes one run per date.

### Capacity math

| Question | Working | Result |
|---|---|---|
| Users per Lambda run? | ~150 ms/note × 1,000 | 150 s, well under the 15-min cap |
| Why not 10,000 per file? | 150 ms × 10,000 | 25 min, **over the cap** |
| Emails/s at 200 Lambdas | 200 × (1,000 ÷ 150 s) | ~1,330/s |
| SES quota of 500/s? | — | cap concurrency near **75** |
| Total time at 500/s | 2,000,000 ÷ 500 | ~67 min, inside the window |

**The email provider, not Lambda, sets the pace.** These are design-time estimates; they will be replaced with measured numbers.

### Failure modes (each will have a test)

| Failure | Expected behaviour |
|---|---|
| PDF Lambda times out mid-batch | Batch retried; claimed users skip; no duplicate emails |
| One user's email is invalid | User goes to `failed[]`; rest of the batch continues |
| Email provider throttles | Backoff, then batch retry |
| A batch fails all retries | Run still completes; wrap-up names the file for a targeted rerun |
| Extractor crashes on a range | Task retried; files overwritten with identical content |
| Workflow started twice for one date | Second start rejected |
| Replica lags behind | Extract checks the reconciliation timestamp before reading |

One known gap: if a Lambda dies after the email was accepted but before it returns, the user's key is claimed but their status row is missing. A claimed key is treated as **sent**. For a legal notice, a rare missing status row is fixable; duplicate emails to 1,000 clients are a support incident.

---

## Local development

Everything runs on a laptop with Docker; no AWS account is needed.

| Real AWS | Local stand-in |
|---|---|
| S3, Lambda, Step Functions, DynamoDB, EventBridge, ECS/Fargate | [LocalStack](https://www.localstack.cloud/) |
| RDS Postgres (primary + read replica) | Postgres 17 in Docker: primary + streaming replica |
| SES | [Mailpit](https://mailpit.axllent.org/) (SMTP + web inbox) |

Email sending sits behind an `EmailSender` interface so Mailpit and SES are swappable.

### What's simplified in this build

The architecture above is built as designed. A few parts are implemented at a smaller depth, enough to demonstrate the idea:

| Part | Production design | This build |
|---|---|---|
| Extract parallelism | 8 tasks by user range | Configurable, 2 ranges by default |
| PDF signing | Digital signature with a DSC certificate | SHA-256 hash plus a "signed by" block; real DSC signing documented, not built |
| Ops alert | Pager / Slack | A log line from wrap-up |

### Prerequisites

- Node.js 22 (matches the Lambda `nodejs22.x` runtime)
- Docker Desktop (WSL2 backend on Windows)
- A LocalStack account and auth token. Since March 2026 every LocalStack image requires one. ECS emulation needs a paid or Student plan; the free Hobby plan covers everything else.

Setup and run instructions will land here with the first layer.

---

## Roadmap

Built in layers; each one runs and is tested before the next starts.

- [ ] **0. Local stack:** docker-compose (LocalStack, Postgres, Mailpit) + smoke tests
  - [x] Postgres primary + streaming read replica, schema, replication smoke test
  - [ ] LocalStack, Mailpit
- [ ] **1. One user → one PDF:** render and (hash-)sign a contract note, unit tested
- [ ] **2. Batch from S3:** a real Lambda in LocalStack reads a batch, writes PDFs, sends email
- [ ] **3. Seed + Extract:** synthetic data; keyset-paginated, range-parallel extract; manifest
  - [x] Seed script: deterministic users + trades for a given date (`npm run seed`)
  - [ ] Extract, manifest
- [ ] **4. Step Functions:** the full workflow with concurrency limits, retries, failure tolerance
- [ ] **5. Hardening:** idempotency keys, bulk status write, chaos tests asserting no duplicate emails
- [ ] **6. User path:** API returning a presigned URL for a user's note
- [ ] **7. Observability:** JSON log lines (`tradeDate`, `batchKey`, `userId`) and a per-run summary
- [ ] **8. Real AWS run:** one minimal-cost deploy, measured throughput, full teardown
- [ ] **9. RabbitMQ version:** the same pipeline on competing consumers, benchmarked against this one

---

## Why not…

- **Kafka?** It is a log for streams, not a job queue. Progress is an offset per partition, so it can't say "41 and 43 done, 42 failed". Parallelism is capped by partition count, and there is no notion of a finished job. This workload is a finite set of independent tasks, not a stream.
- **Airflow alone?** It is an orchestrator, not compute. The burst still needs a fleet that scales. A fair production setup is Airflow deciding *when* and calling `StartExecution`.
- **Always-on RabbitMQ consumers?** A reasonable design, and it will be built in layer 9 for comparison. The cost is a fleet idle 16 hours a day and completion tracking you build yourself.
