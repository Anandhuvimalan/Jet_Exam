# JET Journal Trainer

Journal-entry practice platform for student self-practice with admin-managed rosters, workbook imports, timed tests, result review, and AI-assisted admin support.

## Stack

- React 19 + TypeScript + Vite
- Fastify + TypeScript API
- PostgreSQL (`pg`) for production, SQLite (`better-sqlite3`) fallback for local recovery
- ExcelJS workbook import
- Gemini-powered admin assistant

## Development

```bash
npm install
npm run dev
```

- Frontend dev server: `http://localhost:5173`
- API server: `http://localhost:3001`

## Production

```bash
npm run build
npm start
```

Health endpoints:

- `GET /api/health/live`
- `GET /api/health/ready`

## Runtime Configuration

Copy `.env.example` to `.env.local` or `.env`.

Supported server settings:

- `APP_ORIGIN`
- `BODY_LIMIT_MB`
- `COOKIE_SECURE`
- `COOKIE_SAMESITE`
- `CORS_ORIGINS`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `HOST`
- `LOG_LEVEL`
- `PORT`
- `RATE_LIMIT_MAX`
- `RATE_LIMIT_WINDOW_MS`
- `DATABASE_URL`
- `TRUST_PROXY`

## Storage

- Production runtime data can be stored in PostgreSQL by setting `DATABASE_URL`
- SQLite under `data/*.sqlite` remains available as the local fallback/bootstrap store
- Legacy JSON files are only used as import/fallback sources when bootstrapping older data
- Question data seeds from `Jet questions.xlsx` on first start if the question store is empty
- A matching PostgreSQL schema is prepared in `database/schema.sql`
- Set `DATABASE_URL` to run the server against PostgreSQL providers such as Railway

## Current Production Hardening

- PostgreSQL-backed production storage with SQLite fallback boot path
- API `no-store` cache control
- Fastify compression
- Helmet security headers
- Global rate limiting
- Trusted proxy and cookie security config
- Graceful shutdown on `SIGINT` and `SIGTERM`
- Smooth auth restore on browser refresh using tab-scoped cached auth state
