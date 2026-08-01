# Mboa Trust — Backend

Express + MongoDB (Mongoose) API implementing the data model and services described in `Mboa_Trust_Technical_Architecture.md`.

## Stack

- Express (REST API + Socket.IO for messaging)
- MongoDB / Mongoose
- Firebase Admin SDK (verifies ID tokens from Firebase Auth — Google, email/password, phone+OTP)
- Zod (request validation)
- Cloudinary (evidence photo/video + land document storage)
- MTN MoMo / Orange Money sandbox stubs, Smile Identity sandbox stub (see `src/services/`)

## Getting started

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI at minimum
npm run seed:fees      # seeds default FeeConfig values used by feeService
npm run dev            # starts on http://localhost:5000
```

By default `DEV_AUTH_BYPASS=true` in `.env.example`, so you can call protected
routes without setting up Firebase yet: create a user via
`POST /api/v1/projects` will fail (needs a real user id), so first insert a
User document directly (e.g. via `mongosh` or a quick script), then send
requests with header `x-dev-user-id: <that user's _id>` instead of
`Authorization`. Once Firebase credentials are added, set
`DEV_AUTH_BYPASS=false` and clients should send
`Authorization: Bearer <Firebase ID token>` — the first request from a new
Firebase user auto-creates their `User` document.

## Project layout

```
src/
  config/       env loading, MongoDB connection, Firebase Admin init
  models/       Mongoose schemas — one file per collection from the architecture doc
  services/     feeService, paymentService, kycService, storageService, notificationService
  middleware/   auth (Firebase token verification), validation (Zod), error handling, uploads
  validators/   Zod schemas per resource
  controllers/  request handlers + business/state-transition logic
  routes/       Express routers, mounted under /api/v1
  scripts/      one-off scripts (fee config seeding)
  app.js        Express app assembly
  server.js     HTTP + Socket.IO entrypoint
```

## Core flows implemented

- **Funding/escrow**: `POST /api/v1/projects/:id/fund` records an `Escrow`
  "fund" transaction (fee computed via `feeService`, payment collected via
  the sandbox `paymentService`). Milestone evidence submission, approval,
  and automatic escrow release on approval are wired end-to-end
  (`POST /:id/milestones/:milestoneId/evidence`, `.../approval`).
- **Tendering**: `Bid` → accept → auto-generates a `Contract`, rejects
  competing bids, moves the project to `in_progress`.
- **Land**: `LandListing` CRUD, document upload, verification status
  updates (admin/verifier gated).
- **Shared**: `VerificationTask`, `Dispute`, `Rating`, `RiskFlag`,
  `Conversation`/`Message` (+ Socket.IO live delivery), `Notification`,
  `Referral`, `FeeConfig` (single source of truth for all fee math),
  `Subscription`.

## Swapping sandbox → production

Each external integration sits behind its own service module with a
consistent interface (`services/paymentService.js`, `services/kycService.js`,
`services/storageService.js`). Going live is a matter of filling in the real
credentials in `.env` and replacing the mock branch inside each function —
callers never change.
