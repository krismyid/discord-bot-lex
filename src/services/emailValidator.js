import config from '../shared/config.js';
import { logInfo, logError } from '../shared/logger.js';
import { EMAIL_REGEX } from '../shared/constants.js';

/**
 * Validates if an email belongs to the allowed university domain
 * @param {string} email - Email address to validate
 * @returns {boolean} - True if email is valid and from allowed domain
 */
export function validateEmailDomain(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // Normalize email (lowercase, trim)
  const normalizedEmail = email.toLowerCase().trim();

  // Check basic email format
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    logWarn('Invalid email format', { email: normalizedEmail });
    return false;
  }

  // Extract domain
  const domain = normalizedEmail.split('@')[1];

  // Check if domain exactly matches allowed domain
  const allowedDomain = config.security.allowedEmailDomain.toLowerCase();
  
  if (domain !== allowedDomain) {
    logWarn('Email domain not allowed', { 
      email: normalizedEmail, 
      domain, 
      allowedDomain 
    });
    return false;
  }

  logInfo('Email validated successfully', { email: normalizedEmail });
  return true;
}

/**
 * Extracts and validates email from Microsoft Graph API response
 * @param {object} profile - User profile from Microsoft Graph
 * @returns {string|null} - Validated email or null
 */
export function extractEmailFromProfile(profile) {
  // Try multiple possible email fields from Microsoft profile
  const email = profile.mail || profile.userPrincipalName || profile.email;

  if (!email) {
    logError('No email found in Microsoft profile', null, { profile });
    return null;
  }

  // Validate the email
  if (!validateEmailDomain(email)) {
    return null;
  }

  return email.toLowerCase().trim();
}

/**
 * Extracts user's full name from Microsoft profile
 * @param {object} profile - User profile from Microsoft Graph
 * @returns {string} - User's full name
 */
export function extractNameFromProfile(profile) {
  return profile.displayName || 
         `${profile.givenName || ''} ${profile.surname || ''}`.trim() || 
         'Unknown User';
}

export default {
  validateEmailDomain,
  extractEmailFromProfile,
  extractNameFromProfile,
};
