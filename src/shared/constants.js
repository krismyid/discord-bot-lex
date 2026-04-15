// Verification status constants
export const VerificationStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

// Admin action types
export const AdminAction = {
  APPROVE: 'approve',
  REJECT: 'reject',
  BULK_APPROVE: 'bulk_approve',
  UNVERIFY: 'unverify',
  LOGIN: 'login',
  LOGOUT: 'logout',
};

// Error messages
export const ErrorMessages = {
  INVALID_EMAIL_DOMAIN: 'Email must be from @ecampus.ut.ac.id',
  SESSION_EXPIRED: 'Verification session has expired. Please run /verify again.',
  SESSION_NOT_FOUND: 'Invalid verification session. Please run /verify again.',
  ALREADY_VERIFIED: 'You are already verified!',
  VERIFICATION_PENDING: 'Your verification is pending admin approval.',
  VERIFICATION_REJECTED: 'Your verification was rejected. Please contact an administrator.',
  MAX_ATTEMPTS_REACHED: 'Maximum verification attempts reached. Please try again later.',
  UNAUTHORIZED: 'Unauthorized access.',
  INVALID_CREDENTIALS: 'Invalid username or password.',
  MAX_LOGIN_ATTEMPTS: 'Too many login attempts. Please try again later.',
  DATABASE_ERROR: 'A database error occurred. Please try again later.',
  OAUTH_ERROR: 'Failed to authenticate with Microsoft. Please try again.',
  MISSING_PERMISSIONS: 'Bot is missing required permissions.',
};

// Success messages
export const SuccessMessages = {
  VERIFICATION_SUBMITTED: 'Verification request submitted! An admin will review your request soon.',
  VERIFICATION_APPROVED: 'Congratulations! You have been verified and assigned the Verified role.',
  USER_APPROVED: 'User has been approved successfully.',
  BULK_APPROVED: 'All pending users have been approved.',
  USER_REJECTED: 'User has been rejected.',
  USER_UNVERIFIED: 'User verification has been removed.',
  LOGIN_SUCCESS: 'Login successful.',
  ADMIN_CREATED: 'Admin account created successfully.',
};

// Email validation regex
export const EMAIL_REGEX = /^[\w\.-]+@[a-zA-Z\d\.-]+\.[a-zA-Z]{2,}$/;

// Session token format (UUIDv4)
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Rate limit windows (in milliseconds)
export const RateLimits = {
  VERIFY_WINDOW: 60 * 60 * 1000, // 1 hour
  LOGIN_WINDOW: 60 * 60 * 1000, // 1 hour
};

// Discord embed colors
export const EmbedColors = {
  SUCCESS: 0x00ff00, // Green
  ERROR: 0xff0000, // Red
  WARNING: 0xffaa00, // Orange
  INFO: 0x0099ff, // Blue
  PENDING: 0xffff00, // Yellow
};
