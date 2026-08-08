Frontend mock for Mboa Trust Fund Project screen

Files:
- index.html: Mock funding UI
- app.js: UI logic, static FX rates + fee logic, posts to backend /projects/:id/fund
- style.css: Basic styles

Usage:
1. Open frontend-mock/index.html in a browser (or serve with a simple static server).
2. Enter the backend URL (default http://localhost:5000).
3. Provide a Project ID (create one via backend or use an existing project id).
4. (Optional) Provide x-dev-user-id if your backend uses DEV_AUTH_BYPASS.
5. Choose payment method, currency, and amount.
6. Click Confirm and Pay — the mock will POST to the backend and show the response.

Notes:
- This is a mock UI intended for local development only. It uses the same static FX rates and fee rates as the backend mock.
- To run the backend dev server: `npm run dev` from the repo root.
