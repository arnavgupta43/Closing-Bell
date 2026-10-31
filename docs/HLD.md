# High-Level Design: Contract Note Pipeline

This document covers **what** the system must do and **why** it is shaped the way it is. For the concrete services, data contracts and repo layout, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Problem statement

After the trading session closes, a broker must email every client who traded that day a signed PDF **contract note** listing their trades and charges. It is a regulatory document: it must be accurate, delivered the same evening, and retained.

## 2. Requirements

### Functional

1. Generate one contract note per client per trading day, covering all of that client's trades and charges.
2. Sign the PDF and store it permanently.
3. Email the PDF to the client.
4. Record a delivery status per client per day.
5. Let a client download their note later from the app.
6. Report which clients did not get a note, so ops can act.
7. Allow a rerun for a specific trade date (or a specific failed batch).

### Non-functional

| Requirement | Target |
|---|---|
| Scale | ~2M clients, ~10M trade rows per day (50k–100k locally) |
| Delivery window | Reconciliation complete (~16:00 IST) → midnight |
| Correctness | Only reconciled trades; no client emailed twice |
| Isolation | The trading database must not slow down during the run |
| Cost | Pay for the evening's burst, not an idle fleet all day |
| Auditability | A record of what was supposed to be sent and what was sent |

### Out of scope

- Generating trades or reconciliation itself (assumed done upstream).
- Real digital signature certificates (simulated; see ARCHITECTURE.md).
- Email bounce handling and unsubscribes.

## 3. Load shape and why serverless

```
 load
  ▲
  │            ████
  │           ██████
  │           ██████
  │___________██████_____________________________▶ time
  00:00      16:00 18:00                      24:00
```

Huge for an hour or two, zero for the rest of the day, and nobody waits on a response. That favours compute that scales from zero in seconds and is billed per use (Lambda), over a fleet that idles 16 hours.

## 4. High-level components

```
 Trigger ──► Orchestrator ──► Extract ──► Manifest ──► Fan-out workers ──► Wrap-up
                                 │            │              │                │
                                 ▼            ▼              ▼                ▼
                              Trades DB    Object store   Object store     Status DB
                              (read copy)  (batches)      (PDFs) + Email   (bulk write)
                                                          + Idempotency store
```

| Component | Responsibility | Realised as |
|---|---|---|
| Trigger | Start one run per trade date, after reconciliation | EventBridge (`recon.completed` event or cron) |
| Orchestrator | Run the steps in order, retry, and know when everything is done | Step Functions |
| Extract | Read the day's trades once, in chunks, and write self-contained batch files | Fargate tasks (×8 by user range) |
| Manifest | Write the fixed list of batch files for the day | Lambda |
| Fan-out workers | Per batch: render, sign, store and email each user's note | Distributed Map → PDF Lambda |
| Idempotency store | Guarantee each user is emailed at most once per day | DynamoDB conditional writes |
| Wrap-up | Collect all results, bulk-write statuses, alert ops | Lambda |
| User API | Return a short-lived download link for a note | Small Node API + S3 presigned URL |

## 5. Data flow for one evening

1. **Trigger.** Reconciliation finishes and publishes `recon.completed`. A rule starts the workflow with `{ tradeDate }`. The execution is named after the date, so a second start for the same day is rejected.
2. **Extract.** Parallel extractors each own a user-ID range and stream from the read replica with keyset pagination. Every 1,000 users become one batch file that carries each user's email, trades and charges.
3. **Manifest.** All batch file keys are written to `manifest.json`.
4. **Fan-out.** Distributed Map reads the manifest and runs one PDF Lambda per batch file, at most **N** at once.
5. **Per user, inside a PDF Lambda:** claim idempotency key → render PDF → sign → upload to S3 → send email. Per-user failures go into a `failed[]` list.
6. **Retries.** A failed or timed-out batch is retried with backoff; users already claimed skip.
7. **Wrap-up.** Once every batch has finished, one Lambda bulk-writes all statuses and alerts ops with the failure count.
8. **User path.** The app asks the API for a note; the API checks the status and returns a presigned URL.

## 6. Key design decisions

| # | Decision | Why | Alternative rejected |
|---|---|---|---|
| 1 | **Read once, write once** | Workers never open a DB connection: 8 readers + 1 writer instead of thousands | Each worker queries and updates Postgres → connection storm |
| 2 | **Data travels in the work item** | Workers need nothing but the batch file | Message says "process user 42" → 2M queries in a burst |
| 3 | **Stream, chunk and split the read** | Memory stays flat; parallel ranges finish faster | Load 10M rows into one process |
| 4 | **Batch size from the 15-min Lambda cap; concurrency from the email quota** | Numbers derived from limits, not guessed | Arbitrary sizes that time out or get throttled |
| 5 | **An orchestrator, not only events** | Step Functions knows when *all* batches are done, which wrap-up and audit need | S3 events → SQS → Lambda: no notion of "finished" |
| 6 | **Idempotency keys before sending** | Every retry path is at-least-once | Trust retries → duplicate emails |
| 7 | **Trade date as input and execution name** | One run per date; reruns process the right day | Use "today" → a morning rerun processes the wrong day |
| 8 | **Upload PDF before emailing** | If email fails, only the email needs retrying | Email first → a sent note with no stored copy |

## 7. Capacity estimates

| Question | Working | Result |
|---|---|---|
| Users per Lambda run | ~150 ms/note × 1,000 | ~2.5 min (cap is 15 min) |
| Why not 10,000 per file | 150 ms × 10,000 | 25 min, over the cap |
| Emails/s at 200 Lambdas | 200 × (1,000 ÷ 150 s) | ~1,330/s |
| With an SES quota of 500/s | — | cap concurrency near 75 |
| Total time at 500/s | 2,000,000 ÷ 500 | ~67 min |
| Postgres connections during fan-out | workers never connect | 8 + 1 |

**The email quota sets the pace, not Lambda.** These are estimates; they will be replaced with measured numbers. Local runs prove logic, retries and idempotency, not performance.

## 8. Failure handling

| Failure | Behaviour |
|---|---|
| PDF Lambda times out mid-batch | Batch retried; claimed users skip; no duplicate emails |
| One user's email is invalid | User goes to `failed[]`; the rest continue |
| Email provider throttles | Backoff, then batch retry; lower concurrency if repeated |
| A batch fails all retries | Run still completes (failure tolerance); wrap-up names the file for a rerun |
| Extractor crashes on a range | Task retried; files overwritten with identical content |
| Workflow started twice for one date | Second start rejected |
| Replica lags behind | Extract checks the reconciliation timestamp before reading |

**Known gap:** if a Lambda dies after the email was accepted but before returning, the key is claimed but the status row is missing. A claimed key is treated as sent. A rare missing status row is fixable; duplicate legal emails to 1,000 clients are a support incident.

## 9. Trade-offs and alternatives

| Option | Strength | Weakness | Fits when |
|---|---|---|---|
| **This design** | Pay per evening, scales in seconds, built-in completion tracking | AWS lock-in, per-transition Step Functions cost, harder local testing | Bursty, regulated, daily |
| RabbitMQ + always-on consumers | Simple, familiar, no lock-in | Idle fleet 16 h; track completion yourself | Steady daily load |
| Airflow + Kubernetes workers | Strong if the platform exists | Must tune and pay for the cluster | Existing platform team |
| S3 events → SQS → Lambda | Fewer moving parts | No "everything is done" step | No wrap-up needed |
| Kafka | Great for streams, replay, many readers | Offset-based progress, partition-capped parallelism, no per-message retry or "job done" | Real-time per-trade notes also feeding other systems |

**When to move off Lambda:** if volume became steady all day (e.g. notes per trade in real time), always-on containers would be cheaper and simpler.
