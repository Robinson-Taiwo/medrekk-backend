# medrekk-backend handoff
Standalone Express 5 + TS (no any/unknown) + Zod, npm. Pairs with the existing Expo app (medrekk-mobile). In-memory repos behind interfaces; Rumpty behind CloudAdapter.
Done: access flow (code+name -> token -> request -> approve/deny/narrow -> scoped record -> expiry), emergency profile + audit, idempotent sync push, dev auth stub, rate limits, 8 passing tests.
Next: JWT auth, persistent DB adapter, patient/encounter/claim endpoints + sync apply, referrals, USSD, emergency QR, Rumpty adapter.
