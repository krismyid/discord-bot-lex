# Discord University Verification Bot

A Discord bot that verifies university members using Microsoft OAuth (@ecampus.ut.ac.id) with manual admin approval.

## Features

- **Microsoft OAuth Verification**: Students authenticate using their @ecampus.ut.ac.id Microsoft account
- **Manual Admin Approval**: Admins review and approve verification requests via web dashboard
- **Auto Role Assignment**: Automatically assigns "Verified" role upon approval
- **Admin Dashboard**: Web interface for managing verifications with "Approve All" functionality
- **Audit Logging**: Track all admin actions for accountability
- **Free Hosting**: Designed to run on Fly.io free tier

## Quick Start

### Prerequisites

- Node.js 20+ installed
- Discord bot token ([Create bot](https://discord.com/developers/applications))
- Azure AD application ([Create app](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps))
- PostgreSQL database (or use Fly.io Postgres)
- (Optional) Fly.io account for deployment
- (Optional) Cloudflare account for CDN

### Installation

1. **Clone or download this project**:
   ```bash
   cd discord-bot
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Set up database**:
   ```bash
   # Run database migrations
   npm run migrate
   ```

5. **Create first admin account**:
   ```bash
   npm run setup-admin
   # Follow prompts to create admin username/password
   ```

6. **Start the bot**:
   ```bash
   npm start
   ```

## Configuration

### Discord Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create new application
3. Go to "Bot" section and create a bot
4. Copy bot token and add to `.env` as `DISCORD_TOKEN`
5. Enable "Server Members Intent" and "Message Content Intent"
6. Go to "OAuth2" → "URL Generator"
7. Select scopes: `bot`, `applications.commands`
8. Select permissions: `Manage Roles`, `Send Messages`, `Use Slash Commands`
9. Copy URL and invite bot to your server
10. Copy your server ID and add to `.env` as `DISCORD_GUILD_ID`
11. Create a role called "Verified" and copy its ID to `.env` as `VERIFIED_ROLE_ID`

### Microsoft Azure AD Setup

1. Go to [Azure Portal](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps)
2. Click "New registration"
3. Name: "Discord Verification Bot"
4. Supported account types: "Accounts in any organizational directory"
5. Redirect URI: `https://yourdomain.com/auth/callback` (or `http://localhost:8080/auth/callback` for testing)
6. Click "Register"
7. Copy "Application (client) ID" to `.env` as `MICROSOFT_CLIENT_ID`
8. Go to "Certificates & secrets" → "New client secret"
9. Copy secret value to `.env` as `MICROSOFT_CLIENT_SECRET`
10. Go to "API permissions" → "Add permission" → "Microsoft Graph" → "Delegated permissions"
11. Add: `User.Read`, `email`, `profile`, `openid`
12. Click "Grant admin consent"

### Environment Variables

Create a `.env` file with the following:

```env
# Discord Configuration
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_id
DISCORD_GUILD_ID=your_server_id
VERIFIED_ROLE_ID=verified_role_id

# Microsoft OAuth
MICROSOFT_CLIENT_ID=your_azure_client_id
MICROSOFT_CLIENT_SECRET=your_azure_client_secret
MICROSOFT_TENANT_ID=common
OAUTH_REDIRECT_URI=https://yourdomain.com/auth/callback

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/discord_bot

# Web Server
PORT=8080
BASE_URL=https://yourdomain.com
JWT_SECRET=your_random_secret_key_here
ADMIN_SESSION_EXPIRE=24h

# Security
ALLOWED_EMAIL_DOMAIN=ecampus.ut.ac.id
SESSION_EXPIRE_MINUTES=15
MAX_VERIFY_ATTEMPTS=3
```

## Usage

### For Students

1. Join the Discord server
2. Run `/verify` command in any channel
3. Bot sends you a DM with a verification link
4. Click the link and login with your @ecampus.ut.ac.id Microsoft account
5. Wait for admin approval
6. You'll receive a DM when approved and get the "Verified" role

### For Admins

1. Navigate to `https://yourdomain.com/admin/dashboard`
2. Login with admin credentials
3. View pending verification requests
4. Click "Approve" for individual users or "Approve All" for bulk approval
5. View audit logs to see all admin actions

### Discord Commands

**User Commands**:
- `/verify` - Start verification process
- `/status` - Check your verification status

**Admin Commands**:
- `/list [status]` - List verified members (filter by pending/approved/rejected)
- `/unverify <user>` - Remove verification from a user
- `/stats` - Show verification statistics

## Deployment

### Deploy to Fly.io (Free)

1. **Install Fly.io CLI**:
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. **Login to Fly.io**:
   ```bash
   flyctl auth login
   ```

3. **Create Fly.io app**:
   ```bash
   flyctl launch
   # Follow prompts, choose a name for your app
   ```

4. **Create PostgreSQL database**:
   ```bash
   flyctl postgres create
   flyctl postgres attach <postgres-app-name>
   ```

5. **Set environment secrets**:
   ```bash
   flyctl secrets set DISCORD_TOKEN=xxx
   flyctl secrets set MICROSOFT_CLIENT_ID=xxx
   flyctl secrets set MICROSOFT_CLIENT_SECRET=xxx
   flyctl secrets set JWT_SECRET=$(openssl rand -base64 32)
   flyctl secrets set VERIFIED_ROLE_ID=xxx
   flyctl secrets set DISCORD_GUILD_ID=xxx
   flyctl secrets set OAUTH_REDIRECT_URI=https://your-app.fly.dev/auth/callback
   flyctl secrets set BASE_URL=https://your-app.fly.dev
   ```

6. **Deploy**:
   ```bash
   flyctl deploy
   ```

7. **Run migrations**:
   ```bash
   flyctl ssh console
   npm run migrate
   npm run setup-admin
   exit
   ```

8. **Your bot is now running at**: `https://your-app.fly.dev`

### Add Cloudflare CDN (Optional)

1. Add custom domain in Fly.io dashboard
2. In Cloudflare DNS settings:
   - Type: `CNAME`
   - Name: `bot` (or `@` for root domain)
   - Content: `your-app.fly.dev`
   - Proxy: ON (orange cloud)
3. Update environment variables:
   ```bash
   flyctl secrets set BASE_URL=https://bot.yourdomain.com
   flyctl secrets set OAUTH_REDIRECT_URI=https://bot.yourdomain.com/auth/callback
   ```
4. Update Azure AD redirect URI to match new domain

## Development

### Project Structure

```
discord-bot/
├── src/
│   ├── bot/              # Discord bot logic
│   ├── web/              # Express web server
│   ├── database/         # Database models and migrations
│   ├── services/         # Business logic
│   └── shared/           # Shared utilities
├── public/               # Static files (admin UI)
├── scripts/              # Setup and deployment scripts
└── package.json
```

### Available Scripts

```bash
npm start           # Start bot and web server
npm run dev         # Start with auto-reload (nodemon)
npm run migrate     # Run database migrations
npm run setup-admin # Create admin account
npm test            # Run tests
npm run deploy      # Deploy to Fly.io
```

### Local Development

1. Set up a local PostgreSQL database
2. Configure `.env` with local settings
3. Run `npm run migrate` to create tables
4. Run `npm run setup-admin` to create admin account
5. Run `npm run dev` for development with auto-reload
6. Access admin dashboard at `http://localhost:8080/admin/dashboard`

### Testing OAuth Locally

For local OAuth testing, you need to expose your local server to the internet:

**Option 1: ngrok** (easiest):
```bash
ngrok http 8080
# Copy the HTTPS URL and update OAUTH_REDIRECT_URI in .env
# Update Azure AD redirect URI to match
```

**Option 2: Cloudflare Tunnel**:
```bash
cloudflared tunnel --url http://localhost:8080
```

## Security

### Email Validation

The bot strictly validates that emails end with `@ecampus.ut.ac.id`. This prevents:
- Subdomain spoofing (e.g., `@ecampus.ut.ac.id.fake.com`)
- Other domain variations
- Invalid email formats

Regex pattern used: `/^[\w\.-]+@ecampus\.ut\.ac\.id$/i`

### Session Security

- Session tokens are cryptographically random UUIDs
- Tokens expire after 15 minutes
- One-time use only (invalidated after OAuth callback)
- Stored securely in database, never in client-side storage

### Admin Security

- Passwords hashed with bcrypt (cost factor 12)
- JWT tokens for session management (24-hour expiry)
- Rate limiting: max 10 login attempts per IP per hour
- HTTPS enforced for all admin endpoints

### Rate Limiting

- Users: max 3 verification attempts per hour
- Admins: max 10 login attempts per IP per hour
- Exponential backoff on repeated failures

## Troubleshooting

### Bot not responding to commands

1. Check `DISCORD_TOKEN` is correct
2. Verify bot has "Server Members Intent" enabled
3. Ensure commands are registered: `npm run deploy-commands`
4. Check bot has required permissions in Discord server

### OAuth callback fails

1. Verify `OAUTH_REDIRECT_URI` matches Azure AD configuration exactly
2. Ensure HTTPS is used (not HTTP)
3. Check `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` are correct
4. Verify session token hasn't expired (15 min limit)

### Database connection errors

1. Check `DATABASE_URL` format: `postgresql://user:pass@host:port/dbname`
2. Verify PostgreSQL is running
3. Ensure migrations have been run: `npm run migrate`
4. Check firewall allows connections to database

### Email validation rejects valid emails

1. Ensure email ends exactly with `@ecampus.ut.ac.id`
2. Check for extra whitespace
3. Verify case-insensitive matching is working
4. Test regex: `/^[\w\.-]+@ecampus\.ut\.ac\.id$/i`

## Architecture

For detailed architecture documentation, see:
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Human-readable architecture guide
- [AGENTS.md](./AGENTS.md) - AI agent context and development guide

## License

MIT License - feel free to use and modify for your university community.

## Support

For issues, questions, or contributions, please open an issue on the repository.

## Acknowledgments

Built for Universitas Indonesia (UI) college student community.
