# Discord UT Verification Bot - Architecture

## Overview
A Discord bot for Universitas Terbuka (UT) that verifies students via myut QR code. Runs entirely on Cloudflare's free platform — Workers, D1, R2. Zero VPS, zero cost.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     CLOUDFLARE PLATFORM                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Discord ──POST──> Worker (/interactions)                    │
│       │               │                                      │
│       │               ├── Verify Ed25519 signature           │
│       │               ├── /verify → create session in D1     │
│       │               ├── /status → query D1                 │
│       │               └── Reply with verification link       │
│       │                                                      │
│  Student opens link in browser                               │
│       │                                                      │
│       ▼                                                      │
│  Worker serves verification page (HTML/JS)                   │
│       │                                                      │
│       ├── Client: jsQR decodes QR code                       │
│       ├── Client: Canvas converts to WebP                    │
│       └── Client: POSTs {sessionId, myutUrl, webpImage}      │
│       │                                                      │
│       ▼                                                      │
│  Worker processes verification                               │
│       │                                                      │
│       ├── Validate session (D1)                              │
│       ├── Rate limit check (D1)                              │
│       ├── Validate myut URL pattern                          │
│       ├── Call myut GraphQL API → student data               │
│       ├── Upload WebP to R2 (temp + permanent)               │
│       ├── Save to D1 (status: approved, verified_at)         │
│       ├── Discord REST API: assign Verified role             │
│       └── Discord REST API: DM user confirmation             │
│                                                              │
│  Admin opens /admin                                           │
│       │                                                      │
│       ├── JWT authentication (HMAC-SHA256 via Web Crypto)    │
│       ├── View verify attempts + stats                        │
│       ├── Export CSV (MTD/month/year/all)                     │
│       ├── View eKTM images from R2 permanent                  │
│       └── Manage admins (invite/delete)                       │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  D1 (SQLite)     │  R2 (temp)      │  R2 (permanent)        │
│  verify_attempts │  <UUID>.webp    │  ektm/<NIM>.webp       │
│  sessions        │  (14-day TTL)   │  (permanent)           │
│  admins          │                 │                        │
└─────────────────────────────────────────────────────────────┘

External:
  Discord Interactions API (POST inbound)
  Discord REST API v10 (role assign, DM)
  myut GraphQL API (api-sia.ut.ac.id)
  jsQR CDN (client-side QR decoding)
```

## Key Design Decisions

### Why no discord.js / WebSocket?
Cloudflare Workers are request-response (serverless). No persistent WebSocket connection to Discord Gateway. Instead, we use the **Interactions API** — Discord sends POST requests to our Worker endpoint for slash commands.

### Why client-side QR reading + WebP conversion?
Workers have a 10ms CPU time limit on the free tier. QR decoding and image conversion are CPU-heavy. Moving these to the browser eliminates server-side processing entirely.

### Why two R2 buckets?
- **ektm-temp**: Captures every attempt (success or fail) for auditing. Auto-deleted after 14 days via R2 lifecycle rule.
- **ektm-images**: Only stores verified student images. Permanent.

## Worker Routes

| Method | Path | Handler | Purpose |
|---|---|---|---|
| POST | `/interactions` | `handleInteraction()` | Discord Interactions API |
| GET | `/v/:sessionId` | `handleVerificationPage()` | Serve verification HTML |
| POST | `/v/:sessionId` | `processVerification()` | Process QR + API + save |
| POST | `/register-commands` | `handleRegisterCommands()` | One-time slash command setup |
| GET | `/admin` | `getAdminHTML()` | Admin dashboard SPA |
| POST | `/admin/login` | `handleAdminLogin()` | JWT login |
| GET | `/admin/me` | `handleAdminMe()` | Get current admin |
| GET | `/admin/admins` | `handleAdminListAdmins()` | List all admins |
| POST | `/admin/invite` | `handleAdminInviteAdmin()` | Invite new admin |
| POST | `/admin/delete` | `handleAdminDeleteAdmin()` | Delete admin (with protections) |
| GET | `/admin/attempts` | `handleAdminListAttempts()` | List verify attempts |
| GET | `/admin/export` | `handleAdminExportCSV()` | Export CSV |
| GET | `/admin/image` | `handleAdminSignedImageUrl()` | Serve eKTM image |

## Database Schema

### verify_attempts
Every verification attempt — success or failure — is recorded.

| Column | Type | Purpose |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| discord_id | TEXT | Discord user ID |
| discord_username | TEXT | Discord username |
| status | TEXT | `processing`, `approved`, `failed`, `expired` |
| temp_image_id | TEXT (UUID) | Links to R2 temp bucket file |
| nim | TEXT | Student NIM (from myut API) |
| nama | TEXT | Student name |
| study_program | TEXT | Study program/major |
| ut_region | TEXT | UT regional center (UPBJJ) |
| class_of | TEXT | Registration period (e.g. "20231") |
| myut_url | TEXT | The myut QR URL |
| ektm_image_url | TEXT | R2 permanent key (ektm/<NIM>.webp) |
| created_at | TEXT | Attempt timestamp |
| verified_at | TEXT | Approval timestamp (null if failed) |

Partial unique index: `nim WHERE status='approved'` — same NIM can't be approved twice.

### sessions
Tracks active verification sessions (10-minute expiry).

| Column | Type | Purpose |
|---|---|---|
| id | TEXT (UUID) | Session ID (in verification link) |
| discord_id | TEXT | Discord user who initiated |
| discord_username | TEXT | Discord username |
| status | TEXT | `active`, `used`, `expired` |
| created_at | TEXT | Creation time |
| expires_at | TEXT | Expiry time |

### admins
Admin users for the dashboard. Default admin: `krismyid@gmail.com`.

| Column | Type | Purpose |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| email | TEXT | Admin email (unique) |
| invited_by | TEXT | Email of admin who invited |
| created_at | TEXT | Creation time |

Protections:
- Admin cannot delete self
- Default admin (`krismyid@gmail.com`) cannot be deleted

## Discord Integration

### Signature Verification
All requests to `/interactions` are verified via Ed25519 signature using Web Crypto API. This proves requests come from Discord, not a third party.

### Role Assignment
```
PUT /guilds/{guild_id}/members/{user_id}/roles/{role_id}
Authorization: Bot {token}
```

### DM User
```
POST /users/@me/channels  { recipient_id: userId }  → get DM channel
POST /channels/{channel_id}/messages  { content: "..." }
```

Both are fire-and-forget via `ctx.waitUntil()` — they don't block the response.

## Admin Authentication

JWT using HMAC-SHA256 via Web Crypto API. No npm packages needed.

- **Login**: `POST /admin/login` with `{ email }` returns JWT (24-hour expiry)
- **Subsequent requests**: `Authorization: Bearer <token>` header
- **Secret**: `JWT_SECRET` set via `wrangler secret put`

## Cloudflare Free Tier Limits

| Service | Limit | Sufficient? |
|---|---|---|
| Workers | 100K requests/day, 10ms CPU | Yes — low volume |
| D1 | 5GB, 5M reads/day, 100K writes/day | Yes |
| R2 | 10GB, 1M writes/day, 10M reads/day | Yes |
| Subrequests | 50 per request | Yes — 3-4 per verification |

## File Structure

```
discord-bot-lex/
├── src/
│   └── worker.js          # All Worker logic (routes, Discord API, myut API, R2, D1)
├── sample/                # Test eKTM images
│   ├── ektm1.png          # Digital eKTM screenshot (PNG)
│   ├── ektm2.jpg          # Digital eKTM screenshot (JPG)
│   └── ektm3.jpg          # Physical card photo (rejected by QR pattern)
├── schema.sql             # D1 schema (verify_attempts + sessions + admins)
├── wrangler.toml          # Cloudflare bindings + env vars
├── package.json           # Dev deps only (wrangler)
├── ARCHITECTURE.md        # This file
├── AGENTS.md              # AI agent context
├── README.md              # Setup guide
└── SETUP.md               # Implementation status
```
