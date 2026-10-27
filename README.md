# medrekk-backend

The API, consent engine and audit trail behind **MedRekk**, an offline-first, patient-owned
medical record.

**Documentation:** [the MedRekk docs](https://github.com/Robinson-Taiwo/medrekk/tree/main/docs)

```bash
npm install
cp .env.example .env
npm run dev        # http://localhost:4000
npm test           # 24 suites, ~16s, no database needed
npm run typecheck
```

With no `DATABASE_URL` it runs entirely in memory and seeds demo accounts — the fastest way to see
the whole consent flow.

## What it owns

Who may see what, for how long, and what was actually looked at. Plus the record itself,
referrals, USSD sessions, emergency profiles, credential approval, and an idempotent sync
endpoint for work recorded offline.

## Structure

```
src/routes/       thin HTTP: parse with Zod, call a service, return
src/services/     all the behaviour; knows nothing about Express
src/database/     repository interfaces + postgres/ and in-memory implementations
src/shared/       types and schemas shared with the mobile app
src/middleware/   auth, rate limiting, error shaping
```

Services take dependencies as an object, so tests build a whole app with in-memory repositories
and a fixed clock. Because both storage implementations satisfy the same interfaces, the config
layer can enforce what would otherwise be a comment: `AUTH_MODE=dev` is **refused** whenever
`DATABASE_URL` is set.

## Environment

See `.env.example`. Two worth calling out:

- **`DATA_ENCRYPTION_KEY`** — required with Postgres, and not recoverable. Without it the stored
  record cannot be read. Back it up before the first production write.
- **`CORS_ORIGIN`** — must include the deployed web origin, or the browser-side reader and
  emergency lookup fail with nothing in the server logs to show for it.

## The other repositories

- [`medrekk`](https://github.com/Robinson-Taiwo/medrekk) — the mobile app, and the documentation
- [`medrekk-web`](https://github.com/Robinson-Taiwo/medrekk-web) — site, clinician reader, emergency lookup
