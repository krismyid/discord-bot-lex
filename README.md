# Discord UT Verification Bot

A Discord bot that verifies Universitas Terbuka (UT) students via myut QR code. Runs entirely on **Cloudflare's free platform** — zero VPS, zero cost.

## How It Works

1. Student runs `/verify` in Discord
2. Bot replies with a verification link (ephemeral, only visible to student)
3. Student opens link and uploads a screenshot of their digital eKTM
4. Browser reads QR code (jsQR) + converts to WebP (Canvas API)
5. Worker fetches student data from myut API, auto-approves
6. Discord role assigned + DM sent

**Physical student card QR codes are rejected** — only digital eKTM from myut.ut.ac.id is accepted.

## Features

- **QR Code Verification**: Upload eKTM screenshot, bot reads QR and verifies via UT's own API
- **Auto-Approval**: If QR is valid and myut API returns student data, you're verified instantly
- **Client-Side Processing**: QR decoding and image conversion happen in the browser — no server CPU load
- **Dual R2 Storage**: Temp bucket for every attempt (14-day TTL), permanent bucket for verified eKTMs
- **NIM Uniqueness**: Same NIM can't verify with a different Discord account
- **Rate Limiting**: 1st & 2nd attempt instant, 3rd waits 5 min, 4th+ waits 1 hour
- **Admin Dashboard**: JWT-authenticated web panel — export CSV, view eKTM images, manage admins
- **Zero Cost**: Cloudflare Workers + D1 + R2 free tier

## Admin Dashboard

Access via `/admin` — e.g., `https://your-worker.workers.dev/admin`

**Default admin**: `krismyid@gmail.com`

**Features**:
- Stats dashboard (total attempts, verified, this month, failed)
- View all verify attempts with filters (MTD/month/year/all)
- Export data to CSV (opens in Excel)
- View eKTM images directly from the dashboard
- Invite/delete admins (protections: can't delete self, can't delete default admin)

## Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) (free)
- Discord bot token ([Create bot](https://discord.com/developers/applications))
- Node.js 20+ (for wrangler CLI only)

### Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create D1 database**:
   ```bash
   npx wrangler d1 create discord-ut-verify
   # Copy the database_id from output into wrangler.toml
   ```

3. **Create R2 buckets**:
   ```bash
   npx wrangler r2 bucket create ektm-temp
   npx wrangler r2 bucket create ektm-images
   ```

4. **Set up R2 lifecycle rule** for `ektm-temp`:
   - Cloudflare Dashboard → R2 → ektm-temp → Settings → Object lifecycle
   - Add rule: Delete objects after 14 days

5. **Run database migration**:
   ```bash
   npx wrangler d1 execute discord-ut-verify --file=schema.sql
   ```

6. **Configure environment**:
   - Edit `wrangler.toml` → fill in `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `VERIFIED_ROLE_ID`
   - Set secrets:
     ```bash
     npx wrangler secret put DISCORD_BOT_TOKEN
     npx wrangler secret put JWT_SECRET   # For admin JWT auth (any long random string)
     ```

7. **Register slash commands** (one-time):
   ```bash
   npx wrangler dev
   # In another terminal:
   curl -X POST http://localhost:8787/register-commands
   ```

8. **Deploy**:
   ```bash
   npx wrangler deploy
   ```

9. **Configure Discord Interactions Endpoint**:
   - Discord Developer Portal → General Information → Interactions Endpoint URL
   - Set to: `https://your-worker.workers.dev/interactions`

### Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create application → Bot → copy token
3. Enable "Server Members Intent" (needed for role assignment)
4. OAuth2 → URL Generator → scopes: `bot`, `applications.commands`
5. Permissions: `Manage Roles`, `Send Messages`
6. Invite bot, copy server ID → `DISCORD_GUILD_ID`
7. Create "Verified" role, copy ID → `VERIFIED_ROLE_ID`

### Environment Variables

**wrangler.toml (non-secret)**:
```toml
[vars]
DISCORD_PUBLIC_KEY = ""       # From Discord Developer Portal → General Information
DISCORD_APPLICATION_ID = ""   # From Discord Developer Portal → General Information
DISCORD_GUILD_ID = ""         # Your Discord server ID
VERIFIED_ROLE_ID = ""         # The "Verified" role ID
```

**Secrets (wrangler secret put)**:
```bash
DISCORD_BOT_TOKEN             # Bot token from Discord Developer Portal
JWT_SECRET                    # Admin JWT signing key (any long random string)
```

## Usage

### For Students

1. Join the Discord server
2. Run `/verify`
3. Click the link in the bot's response
4. Upload a screenshot of your digital eKTM (from myut.ut.ac.id)
5. Get verified instantly — role assigned + DM confirmation

### For Admins

1. Visit `/admin` on your Worker domain
2. Login with your admin email (default: `krismyid@gmail.com`)
3. View dashboard, export CSV, view images, manage admins

### Discord Commands

- `/verify` — Start verification (get link to upload eKTM)
- `/status` — Check your verification status (NIM, Nama, etc.)

## Local Development

```bash
npx wrangler dev                              # Start Worker locally
npx wrangler d1 execute discord-ut-verify \
  --local --file=schema.sql                   # Set up local D1
```

Then open:
- `http://localhost:8787/v/<any-uuid>` to test the verification page
- `http://localhost:8787/admin` to test the admin dashboard

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed system design.

## License

MIT
