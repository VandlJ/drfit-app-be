# drfit-app-be

Production-ready REST API backend for a private fitness center booking app.
Clients reserve the entire gym for hourly slots, pay with credits, and access
the gym via a 6-digit PIN shown in the mobile app.

## Stack

- Node.js + TypeScript
- Fastify 4
- Prisma + PostgreSQL
- JWT auth (15 min access + 30 day DB-stored refresh tokens)
- Stripe (PaymentIntents + webhook)
- Expo Push Notifications
- node-cron (in-process scheduler)
- Zod for request validation

## Setup

```bash
cp .env.example .env          # then fill in values
npm install
npx prisma migrate dev --name init
npx prisma db seed
npm run dev                   # tsx watch
```

Production:
```bash
npm run build
npm start
```

## Environment

See [.env.example](.env.example) for all required variables.

## Endpoints

### Auth (`/auth`)
- `POST /auth/register` — `{ email, password, name }`
- `POST /auth/login` — `{ email, password }`
- `POST /auth/refresh` — `{ refreshToken }`
- `POST /auth/logout` *(protected)* — `{ refreshToken }`
- `GET  /auth/me` *(protected)*

### Slots (`/slots`)
- `GET  /slots?date=YYYY-MM-DD` *(protected)*
- `POST /slots` *(admin — `x-admin-secret` header)* — `{ date, startTime, endTime, priceCredits }`

### Reservations (`/reservations`)
- `GET    /reservations` *(protected)*
- `POST   /reservations` *(protected)* — `{ slotId }`
- `DELETE /reservations/:id` *(protected)*
- `GET    /reservations/:id/pin` *(protected, 30 min before start until end)*

### Credits (`/credits`)
- `GET  /credits/balance` *(protected)*
- `GET  /credits/history?limit=&offset=` *(protected)*
- `POST /credits/topup` *(protected)* — `{ packageId }` returns `{ clientSecret }`
- `POST /credits/webhook` *(Stripe, raw body, signature-verified)*

### Push tokens (`/notifications`)
- `POST   /notifications/token` *(protected)* — `{ token, platform }`
- `DELETE /notifications/token` *(protected)* — `{ token }`

### Feedback (`/feedback`)
- `POST /feedback` *(protected)* — `{ rating (1-5), comment?, reservationId? }`

## Top-up packages (config, not DB)

| id       | credits | bonus | priceKc |
|----------|---------|-------|---------|
| starter  | 500     | 0     | 500     |
| standard | 1000    | 0     | 1000    |
| premium  | 2000    | 200   | 2000    |
| pro      | 5000    | 750   | 5000    |

## Cron jobs (run every minute)

1. **60-min reminder** — slots starting in 55–65 min
2. **PIN push** — slots starting in 4–6 min (delivers the PIN)
3. **End warning** — slots ending in 9–11 min
4. **Mark completed** — sets `ACTIVE` reservations whose slot has ended to `COMPLETED`

Notifications are deduplicated via `SentNotification(reservationId, type)` unique constraint.

## Test users (after seed)

- `test1@drfit.app` / `test1234` (1000 credits)
- `test2@drfit.app` / `test1234` (1000 credits)

10 slots are seeded across the next 5 days (10:00–11:00, 16:00–17:00, 200 credits each).

## Notes

- Reservation creation runs in a `Serializable` Prisma transaction to avoid double-booking.
- PIN is stored plaintext (it is a physical access code, not a password); access is gated by the API.
- Stripe webhook uses a per-route `rawBody` config so the JSON parser preserves the raw buffer for signature verification.
- Idempotent webhook: re-deliveries of `payment_intent.succeeded` skip already-applied top-ups.
- Cancellation: refunds 100% if cancelled at least `CANCELLATION_POLICY_HOURS` before start, otherwise `CANCELLATION_REFUND_PERCENT`.
