# CLAUDE.md

Closing Bell: a serverless pipeline that emails every client a signed PDF contract note after market close. Resume and learning project, built locally on LocalStack + Docker, with one minimal-cost AWS run at the end.

- Requirements and reasoning: [docs/HLD.md](docs/HLD.md)
- Services, workflow, storage, data contracts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Roadmap (layers): [README.md](README.md#roadmap)

## Working agreement

- **Keep it simple.** The owner is a junior developer. The goal is to show a clear problem-solving approach they can explain in an interview, not a production-grade system. Prefer the simplest code that demonstrates the idea; mention the production upgrade as a talking point instead of building it.
- **Don't diverge from the design.** Simplify how deep a part is built, never the architecture in `docs/ARCHITECTURE.md`. Ask before adding, removing or replacing a component.
- **Build in layers.** Follow the roadmap order. Each layer runs and is tested before the next starts.
- **Teach while building.** Before each layer: a short concept explanation with a small ASCII diagram. Ask whether the owner wants to write the core logic (you review) or you write it (explain it line by line).
- **Explain trade-offs.** For each choice, one line on the alternative and why it wasn't taken. Point out good interview talking points.
- **Flag LocalStack vs AWS differences** whenever something behaves differently on real AWS.
- **Don't start coding a new phase until asked.**
- Keep docs in sync: update `docs/ARCHITECTURE.md` and the README roadmap when a layer lands.

## Conventions

- Node.js 22 + TypeScript (Lambda runtime `nodejs22.x`).
- Few dependencies, small files, no clever abstractions.
- `tradeDate` is always an input; never derive it from the current clock inside the pipeline.
- Email goes through the `EmailSender` interface (Mailpit locally, SES on AWS).
- PDF workers never connect to Postgres.

## Local environment

- Windows 11, Docker Desktop (WSL2). Shell commands may run in PowerShell or Git Bash.
- Postgres for this project: primary on host port **5442**, read replica on **5443** (5432/5433 are used by another project).
- Mailpit: SMTP `localhost:1025`, inbox `http://localhost:8025`.
- LocalStack: `http://localhost:4566`; needs `LOCALSTACK_AUTH_TOKEN` in a gitignored `.env`. Never commit tokens.

## Commands

Add setup, test and run commands here as each layer lands.

```sh
docker compose up -d          # Postgres primary (:5442) + replica (:5443)
sh scripts/db-smoke.sh        # replication smoke test (Git Bash)
docker compose down -v        # stop and wipe data; init scripts rerun on next up
npm install
npm run seed -- --date 2026-10-16 --users 10   # synthetic users + trades (defaults shown); rerun-safe
npm run typecheck
```

Schema lives in `db/primary/02-schema.sql` and only runs on an empty volume: after changing it, `down -v` then `up -d`.
