# AGENTS.md - AI Agent Project Context

## Project Identity

**Name**: Discord University Verification Bot  
**Purpose**: Verify Discord server members using university Microsoft accounts (@ecampus.ut.ac.id) with manual admin approval  
**Target**: Universitas Indonesia (UI) college student community server  
**Status**: In Development  

## Core Objectives

1. **User Verification**: Students verify identity using their @ecampus.ut.ac.id Microsoft account via OAuth
2. **Manual Approval**: Admin reviews and approves/rejects verification requests through web dashboard
3. **Role Assignment**: Automatically assign "Verified" role in Discord upon admin approval
4. **Audit Trail**: Track all verification and admin actions for accountability
5. **Free Hosting**: Deploy using free-tier services (Fly.io + optional Cloudflare)

## System Architecture Summary

### Component Overview

```
Discord Bot (discord.js) ←→ Express Web Server ←→ PostgreSQL Database
                                    ↑
                            Microsoft OAuth API
                                    ↑
                            Admin Dashboard (HTML/JS)
```

### Technology Stack

- **Runtime**: Node.js 20 LTS
- **Discord Library**: discord.js v14+
- **Web Framework**: Express.js
- **Database**: PostgreSQL 15
- **OAuth Provider**: Microsoft Identity Platform (@azure/msal-node)
- **Authentication**: JWT (jsonwebtoken) + bcrypt
- **Hosting**: Fly.io (free tier)
- **CDN**: Cloudflare (optional, for improved performance)

### File Structure

```
discord-bot/
├── src/
│   ├── bot/              # Discord bot logic
│   ├── web/              # Express web server
│   ├── database/         # Database schemas and models
│   ├── services/         # Business logic (OAuth, email validation)
│   └── shared/           # Shared utilities (config, logging)
├── public/               # Static files (admin dashboard UI)
├── scripts/              # Setup and deployment scripts
├── .env                  # Environment variables (DO NOT COMMIT)
├── package.json          # Dependencies
├── fly.toml              # Fly.io deployment config
├── ARCHITECTURE.md       # Detailed architecture for humans
└── AGENTS.md             # This file - AI agent context
```

## Critical Business Logic

### Verification Flow

1. User runs `/verify` command in Discord
2. Bot generates unique session token (UUIDv4, expires in 15 minutes)
3. Bot sends DM with OAuth URL containing session token
4. User authenticates with Microsoft (must be @ecampus.ut.ac.id)
5. OAuth callback validates email domain and creates pending verification request
6. Admin reviews request in dashboard and approves/rejects
7. Upon approval, bot assigns "Verified" role and sends confirmation DM

### Security Requirements

**Email Validation**:
- MUST end with `@ecampus.ut.ac.id` (case-insensitive)
- NO subdomain spoofing (e.g., reject `@ecampus.ut.ac.id.fake.com`)
- Validation pattern: `/^[\w\.-]+@ecampus\.ut\.ac\.id$/i`

**Session Management**:
- Session tokens: UUIDv4, stored in database
- Expiry: 15 minutes from creation
- One-time use: invalidated after successful OAuth callback
- No client-side storage of sensitive data

**Admin Authentication**:
- Passwords hashed with bcrypt (cost factor 12)
- JWT tokens for session (24-hour expiry)
- HTTPS-only for all admin endpoints
- Rate limiting: max 10 login attempts per IP per hour

**Rate Limiting**:
- Max 3 verification attempts per Discord user per hour
- Max 10 admin login attempts per IP per hour
- Exponential backoff on repeated failures

## Database Schema

### Key Tables

**users** (verification requests and verified members):
- `discord_id` (PK): Discord user ID
- `discord_username`: Discord username for display
- `email`: University email (@ecampus.ut.ac.id)
- `full_name`: From Microsoft profile
- `verification_status`: 'pending' | 'approved' | 'rejected'
- `session_token`: OAuth session token (nullable)
- `session_expires_at`: Session expiry timestamp
- `verified_at`: Approval timestamp
- `verified_by`: Admin user ID who approved
- `created_at`: Request creation time

**admin_users** (admin accounts):
- `id` (PK): Auto-increment
- `username`: Unique admin username
- `password_hash`: Bcrypt hash
- `discord_id`: Optional Discord ID for admin
- `created_at`: Account creation time

**audit_logs** (admin action history):
- `id` (PK): Auto-increment
- `admin_id` (FK): Reference to admin_users
- `action`: Type of action (approve, reject, bulk_approve, etc.)
- `target_user_id`: Discord ID of affected user
- `details`: JSON details of the action
- `timestamp`: Action timestamp

### Important Constraints

- `users.email` MUST match pattern `%@ecampus.ut.ac.id`
- `users.verification_status` MUST be one of: pending, approved, rejected
- `users.session_token` MUST be unique when not null
- `admin_users.username` MUST be unique

## API Endpoints

### Public Endpoints (no authentication)

- `GET /auth/microsoft?session=<token>` - Redirect to Microsoft OAuth
- `GET /auth/callback?code=<code>&state=<session>` - OAuth callback handler
- `GET /verify/success` - Success page after email validation
- `GET /verify/error?message=<reason>` - Error page

### Admin Endpoints (JWT required)

- `POST /admin/login` - Admin login (returns JWT)
- `GET /admin/dashboard` - Admin dashboard UI
- `GET /api/pending` - Get pending verification requests
- `GET /api/verified` - Get all verified users
- `POST /api/approve/:userId` - Approve single user
- `POST /api/approve-all` - Approve all pending users
- `POST /api/reject/:userId` - Reject user with optional reason
- `GET /api/audit-logs?limit=50&offset=0` - Get audit history
- `GET /api/stats` - Get verification statistics

## Discord Bot Commands

### User Commands

- `/verify` - Start verification process (sends DM with OAuth URL)
- `/status` - Check current verification status

### Admin Commands (require admin role)

- `/list [status]` - List verified members (optionally filter by status)
- `/unverify <user>` - Remove verification from user
- `/stats` - Show verification statistics

## Environment Variables

### Required Variables

```bash
# Discord Configuration
DISCORD_TOKEN=              # Bot token from Discord Developer Portal
DISCORD_CLIENT_ID=          # Application ID
DISCORD_GUILD_ID=           # Server ID where bot operates
VERIFIED_ROLE_ID=           # Role ID to assign verified users

# Microsoft OAuth
MICROSOFT_CLIENT_ID=        # Azure AD application client ID
MICROSOFT_CLIENT_SECRET=    # Azure AD application secret
MICROSOFT_TENANT_ID=        # "common" or specific tenant ID
OAUTH_REDIRECT_URI=         # https://yourdomain.com/auth/callback

# Database
DATABASE_URL=               # PostgreSQL connection string

# Web Server
PORT=8080                   # Port for Express server
BASE_URL=                   # https://yourdomain.com
JWT_SECRET=                 # Random secret for JWT signing
ADMIN_SESSION_EXPIRE=24h    # JWT expiry time

# Security
ALLOWED_EMAIL_DOMAIN=ecampus.ut.ac.id
SESSION_EXPIRE_MINUTES=15
MAX_VERIFY_ATTEMPTS=3
```

## Development Guidelines

### Code Style

- **ES Modules**: Use `import/export` syntax (set `"type": "module"` in package.json)
- **Async/Await**: Prefer async/await over Promise chains
- **Error Handling**: Always use try/catch blocks, log errors with context
- **Logging**: Use structured logging (consider `winston` or `pino`)
- **Validation**: Validate all user inputs (use `zod` or `joi`)

### Testing Strategy

- **Unit Tests**: Test individual functions (email validation, session management)
- **Integration Tests**: Test API endpoints and database operations
- **E2E Tests**: Test full verification flow from Discord command to role assignment
- **Security Tests**: Test injection attacks, rate limiting, session hijacking

### Common Tasks for AI Agents

#### Adding a New Discord Command

1. Create file in `src/bot/commands/<command-name>.js`
2. Export object with `data` (SlashCommandBuilder) and `execute(interaction)` function
3. Register command in `src/bot/index.js`
4. Add appropriate permission checks if admin-only
5. Update AGENTS.md with new command documentation

#### Adding a New API Endpoint

1. Create route handler in `src/web/routes/<route-name>.js`
2. Add middleware for authentication if needed
3. Implement business logic in `src/web/controllers/<controller-name>.js`
4. Add database queries in `src/database/models/<model-name>.js`
5. Update AGENTS.md with endpoint documentation
6. Add validation for request body/params

#### Database Schema Changes

1. Create migration file in `src/database/migrations/<timestamp>-<description>.sql`
2. Write both UP and DOWN migration
3. Test migration on local database
4. Update model files in `src/database/models/`
5. Update AGENTS.md database schema section
6. Run migration on production via deployment script

#### Debugging Common Issues

**Bot not responding to commands**:
- Check `DISCORD_TOKEN` is valid
- Verify bot has `applications.commands` scope
- Ensure commands are registered (run deploy-commands script)
- Check bot has permission in channel

**OAuth callback failing**:
- Verify `OAUTH_REDIRECT_URI` matches Azure AD configuration
- Check `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`
- Ensure session token hasn't expired
- Verify HTTPS is enabled (required for OAuth)

**Email validation rejecting valid emails**:
- Check regex pattern: `/^[\w\.-]+@ecampus\.ut\.ac\.id$/i`
- Verify no extra whitespace in email
- Ensure case-insensitive comparison

**Database connection issues**:
- Verify `DATABASE_URL` format: `postgresql://user:pass@host:port/db`
- Check Fly.io Postgres is running: `flyctl postgres list`
- Ensure database migrations have run

## Deployment Process

### Fly.io Deployment

1. **Initial Setup**:
   ```bash
   flyctl auth login
   flyctl launch
   flyctl postgres create
   flyctl postgres attach <postgres-app-name>
   ```

2. **Set Environment Variables**:
   ```bash
   flyctl secrets set DISCORD_TOKEN=xxx
   flyctl secrets set MICROSOFT_CLIENT_ID=xxx
   flyctl secrets set MICROSOFT_CLIENT_SECRET=xxx
   flyctl secrets set JWT_SECRET=xxx
   # ... set all required env vars
   ```

3. **Deploy**:
   ```bash
   flyctl deploy
   ```

4. **Run Database Migrations**:
   ```bash
   flyctl ssh console
   node scripts/migrate.js
   ```

5. **Create First Admin**:
   ```bash
   node scripts/setup-admin.js
   ```

### Cloudflare CDN Setup (Optional)

1. Add custom domain in Fly.io dashboard
2. In Cloudflare DNS, add CNAME record pointing to `<app-name>.fly.dev`
3. Enable proxy (orange cloud icon)
4. Configure SSL/TLS to "Full (strict)"
5. Update `BASE_URL` and `OAUTH_REDIRECT_URI` environment variables

## Security Considerations

### Authentication Flow Security

- Never expose session tokens in URLs (use POST body or secure cookies)
- Always validate `state` parameter in OAuth callback
- Implement CSRF protection for admin endpoints
- Use HTTPS for all endpoints (enforced by Fly.io and Cloudflare)

### Data Privacy

- Store only necessary user data (Discord ID, email, name)
- Do NOT store Microsoft passwords or tokens
- Implement data retention policy (delete rejected requests after 30 days)
- Provide `/delete-my-data` command for GDPR compliance

### Admin Panel Security

- Implement 2FA for admin accounts (future enhancement)
- Log all admin actions with IP address and timestamp
- Require admin to re-authenticate for sensitive actions (bulk approve)
- Use Content Security Policy (CSP) headers

## Known Limitations

1. **Single Server Support**: Bot currently supports one Discord server (configurable via `DISCORD_GUILD_ID`)
2. **Email Domain**: Only `@ecampus.ut.ac.id` supported (hardcoded, but configurable)
3. **Manual Approval Required**: No automatic approval (by design for security)
4. **Session Storage**: Sessions stored in database (consider Redis for better performance at scale)
5. **No Email Sending**: Bot only sends Discord DMs (no email notifications)

## Future Enhancements

- [ ] Multi-server support (configurable per-guild settings)
- [ ] Email notifications for verification status
- [ ] Admin Discord commands (approve via Discord instead of web)
- [ ] Faculty/department role assignment based on email prefix
- [ ] Periodic re-verification (e.g., annual check for active students)
- [ ] Export verified members list (CSV/JSON)
- [ ] Integrate with university student API for automatic validation
- [ ] Mobile-friendly admin dashboard
- [ ] 2FA for admin accounts
- [ ] Webhook notifications for admins (Discord/Slack)

## AI Agent Instructions

When modifying this project:

1. **Always read ARCHITECTURE.md first** for detailed system design
2. **Maintain security constraints** - never bypass email validation or authentication
3. **Follow the established file structure** - don't create random files
4. **Update documentation** - modify AGENTS.md and ARCHITECTURE.md when adding features
5. **Test security implications** - consider attack vectors for any changes
6. **Preserve audit logging** - log all admin actions without exception
7. **Validate inputs** - never trust user input, always validate
8. **Handle errors gracefully** - provide user-friendly error messages
9. **Use environment variables** - never hardcode secrets or configuration
10. **Write idempotent migrations** - database changes should be reversible

### When asked to add a feature:

1. Determine which layer it belongs to (bot/web/database)
2. Check if database schema needs changes (create migration first)
3. Implement business logic in services layer
4. Add API endpoint or bot command
5. Update admin dashboard if needed
6. Add appropriate error handling and validation
7. Update AGENTS.md and ARCHITECTURE.md
8. Suggest relevant tests to write

### When debugging:

1. Check environment variables are set correctly
2. Verify external services (Discord API, Microsoft OAuth) are accessible
3. Check database connection and schema is up-to-date
4. Review logs for error stack traces
5. Test individual components in isolation
6. Verify permissions (Discord roles, database permissions)

## Contact and Resources

- **Discord Developer Portal**: https://discord.com/developers/applications
- **Azure AD Portal**: https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps
- **Fly.io Dashboard**: https://fly.io/dashboard
- **Cloudflare Dashboard**: https://dash.cloudflare.com
- **discord.js Documentation**: https://discord.js.org/docs
- **Microsoft Graph API**: https://learn.microsoft.com/en-us/graph/overview

## Project Status

**Current Phase**: Architecture and Planning Complete  
**Next Steps**:
1. Initialize Node.js project
2. Set up Discord bot and register commands
3. Configure Azure AD application for OAuth
4. Implement database schema
5. Build verification flow
6. Create admin dashboard
7. Deploy to Fly.io
8. Test end-to-end flow

**Last Updated**: 2026-04-15
