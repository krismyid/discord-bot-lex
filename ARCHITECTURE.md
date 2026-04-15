# Discord University Verification Bot - Architecture

## Overview
A Discord bot for Universitas Indonesia (UI) that verifies members using their @ecampus.ut.ac.id Microsoft accounts with manual admin approval through a web dashboard.

## System Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                           USER FLOW                                 │
└────────────────────────────────────────────────────────────────────┘

Student                     Discord Bot              Web Server           Admin
   │                            │                         │                │
   │──/verify─────────────────>│                         │                │
   │                            │                         │                │
   │<──DM with OAuth URL────────│                         │                │
   │                            │                         │                │
   │────Click URL──────────────────────────────────────>│                │
   │                            │                         │                │
   │<──Microsoft Login Page─────────────────────────────│                │
   │                            │                         │                │
   │──Login with @ecampus.ut.ac.id──────────────────────>│                │
   │                            │                         │                │
   │                            │<──Save to DB────────────│                │
   │                            │   (status: pending)     │                │
   │                            │                         │                │
   │<──"Awaiting approval"──────│                         │                │
   │                            │                         │                │
   │                            │                         │<──Login─────────│
   │                            │                         │                │
   │                            │                         │──View pending──>│
   │                            │                         │   requests      │
   │                            │                         │                │
   │                            │                         │<──Click Approve─│
   │                            │<──Update DB─────────────│   (or Approve   │
   │                            │   (status: approved)    │    All)         │
   │                            │                         │                │
   │<──Role assigned + DM───────│                         │                │
      "You are verified!"        │                         │                │
```

## Components

### 1. Discord Bot (discord.js)
**Runtime**: Node.js  
**Framework**: discord.js v14+  
**Hosting**: Fly.io (persistent process)

**Responsibilities**:
- Listen for slash commands
- Generate OAuth URLs with session tokens
- Assign "Verified" role upon approval
- Send DM notifications to users
- Provide admin commands

**Commands**:
- `/verify` - Start verification process
- `/status` - Check verification status
- `/list` - List all verified members (admin only)
- `/unverify <user>` - Remove verification (admin only)
- `/stats` - Show verification statistics (admin only)

### 2. Web Server (Express.js)
**Runtime**: Node.js  
**Framework**: Express.js  
**Hosting**: Same Fly.io instance as Discord bot  
**Proxy**: Cloudflare CDN (optional but recommended)

**Responsibilities**:
- Handle Microsoft OAuth callbacks
- Validate email domain (@ecampus.ut.ac.id)
- Serve admin dashboard
- Provide REST API for admin actions
- Handle admin authentication

**Endpoints**:

**Public Endpoints**:
- `GET /auth/microsoft` - Redirect to Microsoft OAuth
- `GET /auth/callback` - Handle OAuth callback
- `GET /verify/success` - Show success page
- `GET /verify/error` - Show error page

**Admin Endpoints** (JWT protected):
- `POST /admin/login` - Admin login
- `GET /admin/dashboard` - Admin dashboard UI
- `GET /api/pending` - Get pending verification requests
- `GET /api/verified` - Get verified users
- `POST /api/approve/:userId` - Approve single user
- `POST /api/approve-all` - Approve all pending users
- `POST /api/reject/:userId` - Reject user
- `GET /api/audit-logs` - Get admin action history

### 3. Database (PostgreSQL)
**Hosting**: Fly.io Postgres (free tier)  
**ORM**: pg (native PostgreSQL driver) or Prisma (optional)

**Schema**:

```sql
-- Users table
CREATE TABLE users (
    discord_id VARCHAR(20) PRIMARY KEY,
    discord_username VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255),
    verification_status VARCHAR(20) DEFAULT 'pending',
    session_token VARCHAR(255) UNIQUE,
    session_expires_at TIMESTAMP,
    verified_at TIMESTAMP,
    verified_by VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT valid_status CHECK (verification_status IN ('pending', 'approved', 'rejected')),
    CONSTRAINT valid_email CHECK (email LIKE '%@ecampus.ut.ac.id')
);

-- Admin users table
CREATE TABLE admin_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    discord_id VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Audit logs table
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER REFERENCES admin_users(id),
    action VARCHAR(50) NOT NULL,
    target_user_id VARCHAR(20),
    details TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_users_status ON users(verification_status);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_session_token ON users(session_token);
CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp DESC);
```

### 4. Admin Dashboard (Static HTML/CSS/JS)
**Hosting**: Same Fly.io instance (or Cloudflare Pages for better performance)  
**Framework**: Vanilla JavaScript (no build step needed)

**Features**:
- Login page with JWT authentication
- Dashboard showing:
  - Pending verification count
  - Total verified users
  - Recent activity
- Pending requests table with:
  - Discord username
  - Email address
  - Full name (from Microsoft)
  - Request timestamp
  - Individual "Approve" / "Reject" buttons
- "Approve All" button for bulk approval
- Verified users list with search/filter
- Audit log viewer
- Responsive design (works on mobile)

## Data Flow

### Verification Flow

1. **User initiates verification**:
   - User runs `/verify` in Discord
   - Bot generates unique session token (UUID)
   - Bot stores session in database with 15-minute expiry
   - Bot sends DM with OAuth URL: `https://yourdomain.com/auth/microsoft?session=<token>`

2. **Microsoft OAuth**:
   - User clicks URL, redirected to Microsoft login
   - User logs in with @ecampus.ut.ac.id account
   - Microsoft redirects back to: `https://yourdomain.com/auth/callback?code=<auth_code>&state=<session_token>`

3. **Callback processing**:
   - Server validates session token (exists and not expired)
   - Server exchanges auth code for access token
   - Server fetches user profile from Microsoft Graph API
   - Server validates email ends with `@ecampus.ut.ac.id`
   - Server updates database:
     ```javascript
     {
       email: 'student@ecampus.ut.ac.id',
       full_name: 'Student Name',
       verification_status: 'pending'
     }
     ```
   - Server shows success page: "Request submitted, awaiting admin approval"
   - Bot sends DM to user: "Verification request submitted! An admin will review soon."

4. **Admin approval**:
   - Admin logs into dashboard
   - Admin sees pending requests
   - Admin clicks "Approve" or "Approve All"
   - Server updates database: `verification_status = 'approved'`, `verified_at = NOW()`
   - Server logs action in audit_logs
   - Server notifies Discord bot via internal event
   - Bot assigns "Verified" role to user
   - Bot sends DM to user: "You have been verified! Welcome to the server."

### Security Flow

1. **Session Security**:
   - Session tokens are UUIDv4 (cryptographically random)
   - Tokens expire after 15 minutes
   - One-time use only (invalidated after callback)
   - Stored in database, not client-side

2. **Email Validation**:
   - Domain validation: MUST end with `@ecampus.ut.ac.id`
   - No similar domains allowed (e.g., `@ecampus.ut.ac.id.fake.com`)
   - Email verified by Microsoft OAuth (trusted source)

3. **Admin Authentication**:
   - Passwords hashed with bcrypt (cost factor 12)
   - JWT tokens for session management
   - Tokens expire after 24 hours
   - HTTPS enforced for all admin endpoints

4. **Rate Limiting**:
   - Max 3 verification attempts per user per hour
   - Max 10 login attempts per IP per hour
   - Exponential backoff on failed attempts

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare (Optional CDN)                    │
│  • DDoS Protection                                               │
│  • SSL/TLS Termination                                           │
│  • Caching (for static assets)                                   │
│  • WAF (Web Application Firewall)                                │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ HTTPS
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Fly.io App                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────┐        ┌──────────────────────┐        │
│  │   Discord Bot      │        │   Express Server     │        │
│  │                    │◄──────►│                      │        │
│  │  • WebSocket to    │        │  • OAuth endpoints   │        │
│  │    Discord Gateway │        │  • Admin API         │        │
│  │  • Slash commands  │        │  • Static files      │        │
│  │  • Role assignment │        │                      │        │
│  └────────────────────┘        └──────────────────────┘        │
│           │                              │                      │
│           │                              │                      │
│           └──────────────┬───────────────┘                      │
│                          │                                      │
│                          ▼                                      │
│              ┌─────────────────────┐                           │
│              │   PostgreSQL DB     │                           │
│              │                     │                           │
│              │  • users            │                           │
│              │  • admin_users      │                           │
│              │  • audit_logs       │                           │
│              └─────────────────────┘                           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

External Services:
┌────────────────────────┐
│   Microsoft Graph API   │  (OAuth provider)
│   login.microsoftonline │
│   graph.microsoft.com   │
└────────────────────────┘

┌────────────────────────┐
│   Discord API           │  (Bot gateway)
│   discord.com           │
└────────────────────────┘
```

## Technology Stack

| Component | Technology | Why? |
|-----------|------------|------|
| Bot Runtime | Node.js 20 LTS | Best discord.js support |
| Bot Library | discord.js v14 | Most popular, well-documented |
| Web Server | Express.js | Simple, lightweight |
| Database | PostgreSQL 15 | Reliable, free on Fly.io |
| OAuth | @azure/msal-node | Official Microsoft library |
| Auth | jsonwebtoken + bcrypt | Industry standard |
| Hosting | Fly.io | Free tier, always-on |
| CDN | Cloudflare (optional) | Free, fast, secure |
| Process Manager | PM2 or built-in | Keep bot running |

## Environment Variables

Required configuration:

```env
# Discord
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_GUILD_ID=your_server_id
VERIFIED_ROLE_ID=role_id_for_verified_members

# Microsoft OAuth
MICROSOFT_CLIENT_ID=your_azure_app_client_id
MICROSOFT_CLIENT_SECRET=your_azure_app_secret
MICROSOFT_TENANT_ID=common_or_specific_tenant
OAUTH_REDIRECT_URI=https://yourdomain.com/auth/callback

# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Web Server
PORT=8080
BASE_URL=https://yourdomain.com
JWT_SECRET=random_secret_key_here
ADMIN_SESSION_EXPIRE=24h

# Security
ALLOWED_EMAIL_DOMAIN=ecampus.ut.ac.id
SESSION_EXPIRE_MINUTES=15
MAX_VERIFY_ATTEMPTS=3
```

## Cloudflare + Fly.io Integration

**Setup**:

1. Deploy app to Fly.io, get URL like: `your-app.fly.dev`
2. Add custom domain in Fly.io: `bot.yourdomain.com`
3. In Cloudflare DNS:
   ```
   Type: CNAME
   Name: bot
   Content: your-app.fly.dev
   Proxy: ON (orange cloud)
   ```
4. Cloudflare automatically provisions SSL certificate
5. All traffic routes through Cloudflare's CDN

**Benefits**:
- Free SSL/TLS
- DDoS protection
- Faster global access
- Web Application Firewall (WAF)
- Analytics and logging
- Can use Cloudflare Workers for additional logic

**Configuration**:
```javascript
// In Express app, trust Cloudflare proxy
app.set('trust proxy', 1);

// Get real IP from Cloudflare header
const realIP = req.headers['cf-connecting-ip'] || req.ip;
```

## Scaling Considerations

**Current Architecture** (Free Tier):
- Supports ~100-500 concurrent users
- ~1000 verified members
- ~10 verifications per day

**If Growth Needed**:
1. Upgrade Fly.io resources (add RAM/CPU)
2. Scale PostgreSQL (increase storage)
3. Add Redis for session caching
4. Separate bot and web server to different instances
5. Use Cloudflare Workers for OAuth callbacks (reduce load)

## File Structure

```
discord-bot/
├── src/
│   ├── bot/
│   │   ├── index.js              # Discord bot entry point
│   │   ├── commands/
│   │   │   ├── verify.js         # /verify command
│   │   │   ├── status.js         # /status command
│   │   │   ├── list.js           # /list command (admin)
│   │   │   └── unverify.js       # /unverify command (admin)
│   │   ├── events/
│   │   │   ├── ready.js          # Bot ready event
│   │   │   └── interactionCreate.js
│   │   └── utils/
│   │       ├── roleManager.js    # Role assignment logic
│   │       └── dmHandler.js      # DM sending utilities
│   │
│   ├── web/
│   │   ├── index.js              # Express server entry point
│   │   ├── routes/
│   │   │   ├── auth.js           # OAuth routes
│   │   │   ├── admin.js          # Admin API routes
│   │   │   └── public.js         # Public routes
│   │   ├── middleware/
│   │   │   ├── authMiddleware.js # JWT verification
│   │   │   └── rateLimiter.js    # Rate limiting
│   │   └── controllers/
│   │       ├── oauthController.js
│   │       └── adminController.js
│   │
│   ├── database/
│   │   ├── index.js              # Database connection
│   │   ├── schema.sql            # Database schema
│   │   ├── migrations/           # Database migrations
│   │   └── models/
│   │       ├── User.js
│   │       ├── Admin.js
│   │       └── AuditLog.js
│   │
│   ├── services/
│   │   ├── microsoftAuth.js      # Microsoft OAuth service
│   │   ├── emailValidator.js     # Email domain validation
│   │   └── sessionManager.js     # Session token management
│   │
│   └── shared/
│       ├── config.js             # Configuration loader
│       ├── logger.js             # Logging utility
│       └── constants.js          # Shared constants
│
├── public/                       # Static files for admin dashboard
│   ├── index.html                # Login page
│   ├── dashboard.html            # Admin dashboard
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── login.js
│       └── dashboard.js
│
├── scripts/
│   ├── setup-admin.js            # Create first admin account
│   ├── deploy.js                 # Deployment helper
│   └── migrate.js                # Run database migrations
│
├── .env.example                  # Environment variables template
├── .gitignore
├── package.json
├── fly.toml                      # Fly.io configuration
├── ARCHITECTURE.md               # This file
├── AGENTS.md                     # AI agent documentation
└── README.md                     # Setup and usage guide
```

## Next Steps

1. Set up Discord bot application in Discord Developer Portal
2. Set up Azure AD application for Microsoft OAuth
3. Initialize Node.js project and install dependencies
4. Create database schema
5. Implement bot commands
6. Implement web server and OAuth flow
7. Build admin dashboard
8. Deploy to Fly.io
9. (Optional) Configure Cloudflare CDN
10. Create first admin account
11. Test verification flow end-to-end
