# AGENTS.md - AI Agent Project Context

## Project Identity

**Name**: Discord UT Verification Bot
**Purpose**: Verify UT (Universitas Terbuka) students via myut QR code — runs entirely on Cloudflare's free platform
**Target**: Universitas Terbuka (UT) student community server
**Status**: In Development

## Core Objectives

1. **User Verification**: Students verify by uploading eKTM screenshot on a web page
2. **Auto-Approval**: Bot reads QR code, fetches student data from myut API, auto-approves
3. **Role Assignment**: Assigns "Verified" role via Discord REST API
4. **Image Storage**: eKTM screenshots in Cloudflare R2 (temp + permanent buckets)
5. **Admin Dashboard**: JWT-authenticated web panel for admins (CSV export, image viewing, admin management)
6. **Zero Cost**: Entirely on Cloudflare free tier — Workers, D1, R2

## System Architecture

```
Discord (Interactions API) ──POST──> Worker (/interactions)
                                           │
                                     /verify → create session in D1
                                           │
                                     Reply with verification link
                                           │
Student opens link in browser               │
       │                                    │
       ▼                                    │
Worker serves HTML page ←───────────────────┘
       │
       ├── Client: jsQR decodes QR from image
       ├── Client: Canvas converts to WebP
       └── Client: POSTs {sessionId, myutUrl, webpImage}
       │
       ▼
Worker processes:
  ├── Validate session (D1)
  ├── Rate limit check (D1)
  ├── Call myut GraphQL API → student data
  ├── Upload WebP to R2 (temp + permanent)
  ├── Save to D1 (status: approved)
  ├── Assign role (Discord REST API)
  └── DM user (Discord REST API)

Admin Dashboard:
  ├── JWT authentication (HMAC-SHA256 via Web Crypto)
  ├── View verify attempts + stats
  ├── Export CSV (MTD/month/year/all)
  ├── View eKTM images
  └── Manage admins (invite/delete with protections)
```

## Technology Stack

| Component | Technology | Why? |
|---|---|---|
| Compute | Cloudflare Workers | Free, serverless, always-on |
| Database | Cloudflare D1 (SQLite) | 5GB free, serverless |
| Object Storage | Cloudflare R2 | 10GB free, zero egress |
| QR Reading | jsQR (client-side) | Browser-native, no server processing |
| Image Conversion | Canvas API (client-side) | Browser-native WebP conversion |
| Discord API | Interactions API + REST | No WebSocket needed |
| Admin Auth | JWT (HMAC-SHA256) | No npm packages — Web Crypto only |

## Project Structure

```
discord-bot-lex/
├── src/
│   └── worker.js         # Cloudflare Worker (all routes + logic)
├── sample/               # Test eKTM images
├── schema.sql            # D1 database schema
├── wrangler.toml         # Cloudflare config (D1, R2 bindings)
├── package.json          # Dev deps only (wrangler)
├── ARCHITECTURE.md
├── AGENTS.md
├── README.md
└── SETUP.md
```

## Verification Flow

1. User runs `/verify` in Discord
2. Worker creates session UUID in D1, replies with ephemeral link `https://<domain>/v/<sessionId>`
3. Student opens link in browser
4. Student uploads eKTM screenshot
5. **Client-side**: jsQR decodes QR → extracts myut URL. Canvas converts image to WebP.
6. **Client-side**: POSTs `{sessionId, myutUrl, webpImage}` to Worker
7. Worker validates session, checks rate limits, calls myut GraphQL API
8. Worker uploads to R2 (temp + permanent), saves to D1 (approved)
9. Worker assigns Discord role + sends DM via REST API

## Anti-Spoofing Layers

1. **Image validation**: Canvas.toBlob() fails on non-images (client-side)
2. **URL pattern validation**: QR must decode to `https://myut.ut.ac.id/e/<32-char-hex>`
3. **Physical card detection**: Old `webservice.ut.web.id` QR pattern is rejected with specific message
4. **Bot fetches data itself**: Student data from myut API, not from QR content
5. **NIM uniqueness**: Partial unique index in D1 (`WHERE status='approved'`)
6. **Session binding**: 10-minute expiry, one-time use

## Rate Limiting

| Attempt | Behavior |
|---|---|
| 1st, 2nd | Instant |
| 3rd | Wait 5 minutes |
| 4th+ | Wait 1 hour, or contact admin |

## Admin Protections

- Admin **cannot delete self**
- Default admin (`krismyid@gmail.com`) **cannot be deleted**

## Database Schema (D1 / SQLite)

```sql
CREATE TABLE verify_attempts (
    id TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    temp_image_id TEXT,
    nim TEXT, nama TEXT, study_program TEXT, ut_region TEXT, class_of TEXT, myut_url TEXT,
    ektm_image_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    verified_at TEXT
);
CREATE UNIQUE INDEX idx_attempts_nim_approved ON verify_attempts(nim) WHERE status = 'approved';

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE TABLE admins (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    invited_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO admins (id, email) VALUES ('default', 'krismyid@gmail.com');
```

## Cloudflare R2 Buckets

| Bucket | Purpose | Key Format | Lifecycle |
|---|---|---|---|
| `ektm-temp` | Every verify attempt | `<UUID>.webp` | Auto-delete after 14 days |
| `ektm-images` | Verified student eKTMs | `ektm/<NIM>.webp` | Permanent |

## Environment Variables

**wrangler.toml vars:**
- `DISCORD_PUBLIC_KEY` — Discord app public key (for signature verification)
- `DISCORD_APPLICATION_ID` — Discord app ID
- `DISCORD_GUILD_ID` — Server ID
- `VERIFIED_ROLE_ID` — Role to assign

**Secrets (wrangler secret put):**
- `DISCORD_BOT_TOKEN` — Bot token
- `JWT_SECRET` — Admin JWT signing key

## Key Routes

| Method | Path | Purpose |
|---|---|---|
| POST | `/interactions` | Discord Interactions API |
| GET | `/v/:sessionId` | Serve verification page |
| POST | `/v/:sessionId` | Process verification |
| POST | `/register-commands` | Register slash commands |
| GET | `/admin` | Admin dashboard |
| POST | `/admin/login` | Admin JWT login |

## When modifying this project:

1. Read ARCHITECTURE.md for detailed system design
2. All server logic is in `src/worker.js` — single file
3. HTML/CSS/JS for verification page is embedded in `getVerificationHTML()` function
4. HTML/CSS/JS for admin dashboard is embedded in `getAdminHTML()` function
5. Test locally with `npx wrangler dev`
6. Use `wrangler d1 execute discord-ut-verify --local --file=schema.sql` for local DB
