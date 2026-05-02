# Project Setup

## Implementation Status

### Done
- `src/worker.js` — Cloudflare Worker with all routes:
  - Discord Interactions (`/interactions`) — `/verify` and `/status` commands
  - Verification page (`/v/:sessionId`) — GET + POST processing
  - Admin dashboard (`/admin/*`) — JWT auth, CSV export, image viewing, admin management
  - Slash command registration (`/register-commands`)
- `schema.sql` — D1 schema: `verify_attempts`, `sessions`, `admins` tables
  - Default admin: `krismyid@gmail.com`
- `wrangler.toml` — Cloudflare config (D1, R2 bindings, env vars)
- `package.json` — Dev deps (wrangler CLI only)
- Documentation (ARCHITECTURE.md, AGENTS.md, README.md, SETUP.md)

### Verified
- myut GraphQL API: `POST https://api-sia.ut.ac.id/backend-sia/api/graphql` — returns NIM, Nama, Study Program, UT Region, Class Of
- QR decoding works on digital eKTM screenshots
- Physical card QR codes are detected and rejected with specific message

### Field Naming (Consistent English)
| Column | API Source | Meaning |
|---|---|---|
| nim | nim | Student ID number |
| nama | namaMahasiswa | Student full name |
| study_program | namaProgramStudi | Major/study program |
| ut_region | namaUpbjj | UT regional center |
| class_of | masaRegistrasi | Registration period / year |

### To Set Up
1. Create D1 database: `npx wrangler d1 create discord-ut-verify`
2. Copy `database_id` into wrangler.toml
3. Create R2 buckets:
   ```bash
   npx wrangler r2 bucket create ektm-temp
   npx wrangler r2 bucket create ektm-images
   ```
4. Set R2 lifecycle rule on `ektm-temp` (14-day auto-delete) in Cloudflare Dashboard
5. Run migration: `npx wrangler d1 execute discord-ut-verify --file=schema.sql`
6. Fill in wrangler.toml vars:
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_APPLICATION_ID`
   - `DISCORD_GUILD_ID`
   - `VERIFIED_ROLE_ID`
7. Set secrets:
   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put JWT_SECRET   # any long random string
   ```
8. Deploy: `npx wrangler deploy`
9. Register slash commands: `curl -X POST https://your-worker.workers.dev/register-commands`
10. Set Interactions Endpoint URL in Discord Developer Portal to:
    `https://your-worker.workers.dev/interactions`

### To Test Locally
```bash
npx wrangler dev
npx wrangler d1 execute discord-ut-verify --local --file=schema.sql
# Open http://localhost:8787/admin to test admin dashboard
# Open http://localhost:8787/v/test-session (will show "session not found")
```
