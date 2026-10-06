# medrekk-backend

Standalone Express 5 + TypeScript + Zod backend for MedRekk. Sits beside the Expo app (medrekk-mobile); no workspace coupling.

```bash
npm install
cp .env.example .env
npm run dev        # http://localhost:4000
npm test
npm run typecheck
```

`src/shared/` holds the domain types (`types.ts`) and Zod schemas (`validation.ts`). They have no Node-only imports,
so the Expo app can copy them (or we can extract a shared package later).

Dev auth is header-based (`x-actor-id`, `x-actor-role`) and the server refuses to start in production with it. Replace with JWT.
# medrekk-backend
