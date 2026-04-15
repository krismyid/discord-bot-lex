import winston from 'winston';
import config from './config.js';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom format for log messages
const logFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;
  
  // Add metadata if present
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  
  // Add stack trace for errors
  if (stack) {
    msg += `\n${stack}`;
  }
  
  return msg;
});

// Create logger instance
const logger = winston.createLogger({
  level: config.logging.level,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // Console output
    new winston.transports.Console({
      format: combine(
        colorize(),
        logFormat
      ),
    }),
    
    // File output for errors
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    
    // File output for all logs
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
  exceptionHandlers: [
    new winston.transports.File({ filename: 'logs/exceptions.log' }),
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: 'logs/rejections.log' }),
  ],
});

// Helper functions for structured logging
export const logInfo = (message, metadata = {}) => {
  logger.info(message, metadata);
};

export const logError = (message, error = null, metadata = {}) => {
  if (error instanceof Error) {
    logger.error(message, { ...metadata, error: error.message, stack: error.stack });
  } else {
    logger.error(message, metadata);
  }
};

export const logWarn = (message, metadata = {}) => {
  logger.warn(message, metadata);
};

export const logDebug = (message, metadata = {}) => {
  logger.debug(message, metadata);
};

// Export logger for advanced usage
export default logger;
