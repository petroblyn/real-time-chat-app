# Real-Time Chat App

A WhatsApp-inspired full-stack chat starter built with React, Node.js, Express, Socket.IO and PostgreSQL.

## Features
- Register and log in with password hashing and JWT authentication
- Direct messages between registered users
- Live message delivery with Socket.IO
- Online presence
- Typing indicators
- Read receipts
- Message history stored in PostgreSQL
- File uploads (stored locally in `server/uploads` for development)
- Responsive WhatsApp-inspired interface

## Requirements
Install:
1. Node.js 20 or newer (LTS recommended)
2. PostgreSQL 15 or newer
3. Git (for pushing to GitHub)

Redis and AWS S3 are not required for this local starter. Local uploads are used by default. For production, use S3-compatible object storage, Redis Socket.IO adapter, HTTPS, rate limiting, backups, and a managed database.

## 1. Create the database
Open PostgreSQL's SQL Shell (psql) or pgAdmin and run:

```sql
CREATE DATABASE realtime_chat;
```

The server creates the required tables automatically on startup.

## 2. Configure environment variables
Copy `server/.env.example` to `server/.env` and set your PostgreSQL username/password and a long random JWT secret.

Example for a local PostgreSQL installation:
```env
PORT=4000
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/realtime_chat
JWT_SECRET=replace-this-with-a-long-random-secret
CLIENT_ORIGIN=http://localhost:5173
MAX_UPLOAD_MB=10
```

If your PostgreSQL user has no password, adjust the URL to match your local setup. URL-encode special characters in the password.

## 3. Install and run
From this project folder in PowerShell or a terminal:

```bash
npm install
npm run install:all
npm run dev
```

Open http://localhost:5173. Register two different accounts (use an incognito/private browser window for the second account) and send messages between them.

If the root `npm install` reports a dependency issue, run `npm install` at the root, then `npm install` inside `server` and `client` separately.

## 4. Push to GitHub
Create an empty repository on GitHub. In this folder run:

```bash
git init
git add .
git commit -m "Initial real-time chat app"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

Do not commit `server/.env`, passwords, JWT secrets, or uploaded private files.

## Project structure
```
real-time-chat-app/
  client/        React + Vite UI
  server/        Express REST API + Socket.IO
  README.md
```

## API overview
- `POST /api/auth/register` — create an account
- `POST /api/auth/login` — log in
- `GET /api/users` — list users (auth required)
- `GET /api/messages/:userId` — fetch direct message history
- `POST /api/upload` — upload a file (auth required)
- Socket events: `private_message`, `typing`, `stop_typing`, `mark_read`, `presence`, `message_read`

## Troubleshooting
- `ECONNREFUSED` to port 5432: make sure PostgreSQL is installed and running.
- `password authentication failed`: update `DATABASE_URL`.
- Port 4000 already in use: change `PORT` in `server/.env`.
- File upload error: check that `server/uploads` exists and `MAX_UPLOAD_MB` is not exceeded.
- Test with two different accounts in separate browsers; a user cannot meaningfully test live delivery from a single session alone.

## Production note
This is a runnable MVP/starter, not a security-audited production service. Before public launch, add email verification, password reset, account abuse protection, antivirus/file-type scanning, object storage, HTTPS, database migrations/backups, logging/monitoring, and privacy controls.
