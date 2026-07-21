/**
 * Structured logging infrastructure.
 *
 * Replaces raw chalk/console.log with a structured logger that outputs either
 * JSON (for machine consumption) or colored human-readable text (for terminal).
 *
 * Usage:
 *   import { createLogger } from '../core/logger.js';
 *   const log = createLogger('dispatch');
 *   log.info('Dispatch started', { role: 'cto', issueKey: 'RYA-42' });
 *
 * Environment variables:
 *   LOG_FORMAT=json|pretty  (default: pretty)
 *   LOG_LEVEL=debug|info|warn|error  (default: info)
 */

import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: chalk.dim,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

function getLogFormat(): 'json' | 'pretty' {
  const fmt = process.env.LOG_FORMAT;
  return fmt === 'json' ? 'json' : 'pretty';
}

function getLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL as LogLevel;
  if (level && level in LEVEL_ORDER) return level;
  return 'info';
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatTimeShort(): string {
  return new Date().toLocaleTimeString();
}

function formatPretty(entry: LogEntry): string {
  const ts = formatTimeShort();
  const colorize = LEVEL_COLORS[entry.level];
  const meta = entry.metadata && Object.keys(entry.metadata).length > 0
    ? ' ' + chalk.dim(JSON.stringify(entry.metadata))
    : '';
  return colorize(`[${ts}] [${entry.component}] ${entry.message}${meta}`);
}

function formatJson(entry: LogEntry): string {
  return JSON.stringify(entry);
}

/** Internal write function — separated for testability. */
let _writer: (level: LogLevel, formatted: string) => void = (level, formatted) => {
  if (level === 'error') {
    console.error(formatted);
  } else {
    console.log(formatted);
  }
};

/** Override the writer (for testing). */
export function _setWriter(writer: (level: LogLevel, formatted: string) => void): void {
  _writer = writer;
}

/** Reset the writer to default (for testing). */
export function _resetWriter(): void {
  _writer = (level, formatted) => {
    if (level === 'error') {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  };
}

export function createLogger(component: string): Logger {
  function emit(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[getLogLevel()]) return;

    const entry: LogEntry = {
      timestamp: formatTimestamp(),
      level,
      component,
      message,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    };

    const format = getLogFormat();
    const formatted = format === 'json' ? formatJson(entry) : formatPretty(entry);
    _writer(level, formatted);
  }

  return {
    debug: (message, metadata) => emit('debug', message, metadata),
    info: (message, metadata) => emit('info', message, metadata),
    warn: (message, metadata) => emit('warn', message, metadata),
    error: (message, metadata) => emit('error', message, metadata),
  };
}
