import 'dotenv/config';

const config = {
  // Discord
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    verifiedRoleId: process.env.VERIFIED_ROLE_ID,
  },

  // Microsoft OAuth
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    tenantId: process.env.MICROSOFT_TENANT_ID || 'common',
    redirectUri: process.env.OAUTH_REDIRECT_URI,
  },

  // Database
  database: {
    url: process.env.DATABASE_URL,
  },

  // Web Server
  web: {
    port: parseInt(process.env.PORT || '8080', 10),
    baseUrl: process.env.BASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    adminSessionExpire: process.env.ADMIN_SESSION_EXPIRE || '24h',
  },

  // Security
  security: {
    allowedEmailDomain: process.env.ALLOWED_EMAIL_DOMAIN || 'ecampus.ut.ac.id',
    sessionExpireMinutes: parseInt(process.env.SESSION_EXPIRE_MINUTES || '15', 10),
    maxVerifyAttempts: parseInt(process.env.MAX_VERIFY_ATTEMPTS || '3', 10),
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '10', 10),
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },

  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV !== 'production',
  isProduction: process.env.NODE_ENV === 'production',
};

// Validation
function validateConfig() {
  const required = [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'VERIFIED_ROLE_ID',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_CLIENT_SECRET',
    'OAUTH_REDIRECT_URI',
    'DATABASE_URL',
    'BASE_URL',
    'JWT_SECRET',
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate email domain format
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(config.security.allowedEmailDomain)) {
    throw new Error('ALLOWED_EMAIL_DOMAIN must be a valid domain (e.g., ecampus.ut.ac.id)');
  }

  // Validate URLs
  try {
    new URL(config.web.baseUrl);
    new URL(config.microsoft.redirectUri);
  } catch (error) {
    throw new Error('BASE_URL and OAUTH_REDIRECT_URI must be valid URLs');
  }
}

// Run validation in production
if (config.isProduction) {
  validateConfig();
}

export default config;
