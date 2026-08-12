Local frontend (Vite + React)

This small frontend demonstrates the real funding flow wired to the backend API in this repo.

Quick start:

1. cd frontend
2. npm install
3. npm run dev

Open http://localhost:5173 and use the form to create a payment for an existing project (Mongo ObjectId required).

Notes:
- For Stripe card payments, paste a Stripe publishable key (pk_test_...) in the form or supply VITE_STRIPE_PUBLISHABLE_KEY in .env.local.
- For local dev, the backend accepts x-dev-user-id header when DEV_AUTH_BYPASS=true — the form exposes a Dev user id field.
- The frontend expects the backend at VITE_BACKEND_URL (defaults to http://localhost:5000). You can change that in the form or set it with .env.local.
