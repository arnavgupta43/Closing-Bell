# Architecture: Contract Note Pipeline

This document covers **how** the system is built: services, the workflow, storage layout, data contracts and the repo. For requirements and the reasoning behind the design, see [HLD.md](HLD.md).

> Parts marked *(planned)* are decided in shape but not yet built. This file is updated as each layer lands.

---

## 1. System diagram

```
                     ┌─────────────── STEP FUNCTIONS: contract-notes-daily ───────────────┐
                     │                                                                    │
 EventBridge ─start─►│ [1] Extract ──► [2] Build ──► [3] Distributed Map ──► [4] Wrap-up  │
 (recon.completed    │  Fargate ×8     manifest      1 PDF Lambda per        Lambda       │
  event, or cron)    │  by user range  Lambda        batch file, max N       bulk status  │
                     │                               at once, retries        + alert ops  │
                     └─────┬──────────────┬────────────────┬──────────────────────┬───────┘
                           │ reads chunks │ writes         │ batch in / PDF out   │ bulk COPY
                           ▼              ▼                ▼          │ send      ▼
                  Postgres READ     S3: batches/      S3: notes/      ▼     Postgres PRIMARY
                  REPLICA           S3: manifest      {user}.pdf     SES    note_status

                                                      DynamoDB note_sent
                                                      (idempotency keys)

 USER PATH:  App ──► API ──► note_status ──► presigned S3 URL ──► app downloads PDF from S3
```

Horizontal arrows are control flow; vertical arrows are data.

## 2. Services: AWS and local

| Role | AWS | Local stand-in |
|---|---|---|
| Trigger | EventBridge (rule on `recon.completed`, or Scheduler cron) | LocalStack EventBridge, or `start-run` script calling `StartExecution` |
| Orchestration | Step Functions (Standard workflow) | LocalStack Step Functions |
| Extract | ECS Fargate task | LocalStack ECS (Student plan); fallback: same code as a Lambda |
| Manifest, PDF worker, Wrap-up | Lambda (`nodejs22.x`) | LocalStack Lambda (runs in Docker) |
| Object storage | S3 | LocalStack S3 |
| Idempotency | DynamoDB | LocalStack DynamoDB |
| Email | SES | Mailpit (SMTP on `1025`, inbox UI on `8025`) |
| Trades + status DB | RDS Postgres (primary + read replica) | Postgres 17 in Docker (read-only user plays the replica) |
| User API | Any Node host | Local Node process |

## 3. Workflow: `contract-notes-daily`

**Input:** `{ "tradeDate": "2026-10-16" }`
**Execution name:** `notes-2026-10-16` (a duplicate name is rejected, so one run per date).

| # | State | Type | Does | Retry / limits |
|---|---|---|---|---|
| 1 | `Extract` | Task → ECS `runTask.sync` (one per range, run in parallel) | Streams trades for its user range, writes batch files | Retry on task failure |
| 2 | `BuildManifest` | Task → Lambda | Lists `batches/<date>/` into `manifest.json` | Retry 2× |
| 3 | `SendNotes` | Distributed Map | Reads `manifest.json` from S3; one child per file invokes the PDF Lambda with `{ key }` | `MaxConcurrency: N`, retry 2× with backoff, `ToleratedFailurePercentage` |
| 4 | `WrapUp` | Task → Lambda | Takes all child results, bulk-writes `note_status`, logs the run summary and alert | Retry 2× |

**Choosing N:** set from the email provider's send rate (see HLD §7). Locally N is small (5–10) because each concurrent Lambda is a Docker container on the laptop.

## 4. Storage layout

### S3 bucket `contract-notes`

```
batches/<tradeDate>/batch-0001.json     # written by Extract, 1,000 users each
batches/<tradeDate>/batch-0002.json
manifest/<tradeDate>/manifest.json      # written by BuildManifest
notes/<tradeDate>/<userId>.pdf          # written by the PDF Lambda
```

### DynamoDB table `note_sent`

| Attribute | Value |
|---|---|
| `pk` (partition key) | `<userId>#<tradeDate>` |

Claimed with a conditional put (`attribute_not_exists(pk)`) before a user's note is sent, and deleted again only if rendering, upload or sending fails.

### Postgres

```sql
users       (id, email, name, ...)
trades      (id, user_id, trade_date, symbol, side, qty, price, exchange, traded_at, ...)
            -- index on (trade_date, user_id)
note_status (user_id, trade_date, status, s3_key, ses_message_id, updated_at,
             PRIMARY KEY (user_id, trade_date))
```

Charges are calculated per user from their trades during extract and stored in the batch file.

## 5. Data contracts

```jsonc
// batches/2026-10-16/batch-0042.json
{
  "tradeDate": "2026-10-16",
  "users": [
    {
      "id": "U1042",
      "email": "user1042@example.com",
      "name": "…",
      "trades": [
        { "tradeId": "T9", "symbol": "INFY", "side": "BUY", "qty": 10,
          "price": 1520.5, "exchange": "NSE", "time": "10:14:03" }
      ],
      "charges": { "brokerage": 20, "stt": 15.2, "exchangeTxn": 4.1,
                   "gst": 4.3, "sebi": 0.02, "stampDuty": 2.3 }
    }
  ]
}

// manifest/2026-10-16/manifest.json
{ "tradeDate": "2026-10-16", "files": ["batches/2026-10-16/batch-0001.json", "…"] }

// PDF Lambda input (one Distributed Map item)
{ "key": "batches/2026-10-16/batch-0042.json" }

// PDF Lambda result → goes to WrapUp, never to Postgres
{ "key": "batches/2026-10-16/batch-0042.json", "sent": 997,
  "failed": [{ "userId": "U1099", "reason": "invalid email" }] }
```

## 6. Inside the PDF Lambda

```
for each user in batch:
    claim key  userId#tradeDate  (conditional put)
      ├─ already exists  → skip, count as sent
      ├─ other error     → throw  → Step Functions retries the whole batch
      └─ claimed
           render PDF → sign → upload notes/<date>/<userId>.pdf → send email
             └─ any error → release key, add user to failed[]
return { key, sent, failed }
```

The PDF is uploaded **before** the email is sent, so an email failure never loses the document.

## 7. Code boundaries

| Boundary | Why it exists |
|---|---|
| `EmailSender` interface (`send(to, subject, body, attachment)`) | Mailpit locally, SES on AWS, one file to swap |
| `tradeDate` always passed in | Never read "today" from the clock inside the pipeline, so reruns are correct |
| PDF rendering as a plain function (user + date → buffer) | Unit-testable without AWS; shared with the RabbitMQ version later |

## 8. Repo layout *(planned)*

```
Closing-Bell/
  docker-compose.yml        # localstack, postgres, mailpit
  infra/                    # state machine definition, deploy scripts
  packages/
    shared/                 # types, S3/DynamoDB clients, config
    extract/                # stream DB → batch files
    pdf-worker/             # Lambda: batch → PDFs → S3 → email
    wrap-up/                # Lambda: results → COPY note_status → summary
    api/                    # GET a user's note → presigned URL
  scripts/
    seed.ts                 # synthetic users + trades
    start-run.ts            # StartExecution with { tradeDate }
    chaos.ts                # failure scenarios
  docs/
```

## 9. Local vs AWS differences

| Area | Local | AWS |
|---|---|---|
| LocalStack plan | Needs an auth token; ECS needs the Student plan | n/a |
| Email | Mailpit catches everything; nothing leaves the laptop | SES sandbox: only verified addresses until production access |
| Read replica | Same Postgres, read-only user | Separate RDS replica |
| Concurrency | 5–10 Lambdas (laptop limits) | Set from the SES quota |
| Performance numbers | Not meaningful | Measured in the real AWS run |
| Distributed Map | To be verified in the LocalStack smoke test; fallback is an inline Map over the manifest | Native |

## 10. Simplifications in this build

| Part | Production design | This build |
|---|---|---|
| Read replica | Separate Postgres replica | One Postgres; read-only user |
| Extract parallelism | 8 tasks by user range | Configurable, 2 by default |
| PDF signing | DSC certificate signature | SHA-256 hash and a "signed by" block |
| Ops alert | Pager / Slack | Log line from wrap-up |
| Logging | Centralised, traced | JSON log lines with `tradeDate`, `batchKey`, `userId` |
