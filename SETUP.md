# Project Setup

## Implementation Status (2026-05-02)

**Status**: Deployed to production, Discord Interactions endpoint verified ✅

### Done & Deployed
- `src/worker.js` — All routes working
  - `/interactions` — Discord signature verification (fixed: `Ed25519/raw` instead of `NODE-ED25519/spki`)
  - `/v/:sessionId` — Verification page + processing
  - `/admin/*` — JWT-authenticated dashboard
- D1 database: `discord-ut-verify` (ID: `eb306616-5e56-4e74-a7b0-49b4df9985ad`)
- R2 buckets: `ektm-temp`, `ektm-images`
- Schema migrated: tables created + default admin (`krismyid@gmail.com`)
- All env vars in `wrangler.toml` configured (current test server values)
- Secrets set: `DISCORD_BOT_TOKEN`, `JWT_SECRET`
- Worker deployed: `lex-studyhub-verify` at `https://lex-studyhub-verify.lexcriminalis.workers.dev`
- Slash commands registered: `/verify`, `/status`
- Discord Interactions Endpoint URL verified ✅

### Worker Name Note
- Old name: `discord-ut-verify` (deleted 2026-05-02)
- New name: `lex-studyhub-verify` (active)

### Critical Bug Fixed (2026-05-02)
**Problem**: Discord endpoint verification failed.  
**Cause**: `verifyDiscordSignature()` used:
- `'spki'` key format (wrong — Discord Public Key is raw 32 bytes)
- `'NODE-ED25519'` algorithm (Node.js-only, not supported in Cloudflare Workers)

**Fix applied to `src/worker.js:22-30`**:
- `'raw'` key format
- `'Ed25519'` standard Web Crypto algorithm

### Field Naming (Consistent English)
| Column | API Source | Meaning |
|---|---|---|
| nim | nim | Student ID number |
| nama | namaMahasiswa | Student full name |
| study_program | namaProgramStudi | Major/study program |
| ut_region | namaUpbjj | UT regional center |
| class_of | masaRegistrasi | Registration period / year |

### Optional Remaining Setup
1. **R2 lifecycle rule** for `ektm-temp` (recommended):
   - Cloudflare Dashboard → R2 → `ektm-temp` → Settings → Object lifecycle
   - Add rule: Delete objects after 14 days

2. **Discord role hierarchy** (required for role assignment):
   - Server Settings → Roles
   - Drag bot's role **above** the "Verified" role
   - Save

### When Switching to Main Server
Update in `wrangler.toml`:
- `DISCORD_GUILD_ID`
- `VERIFIED_ROLE_ID`

Then re-deploy:
```bash
npx wrangler deploy
```

Slash commands are global to the Discord app, so they work in any server where the bot is invited.

### To Test Locally
```bash
npx wrangler dev
npx wrangler d1 execute discord-ut-verify --local --file=schema.sql
# Open http://localhost:8787/admin to test admin dashboard
# Open http://localhost:8787/v/test-session (will show "session not found")
```
