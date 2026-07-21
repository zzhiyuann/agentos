import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger, _setWriter, _resetWriter, type LogLevel } from './logger.js';

describe('logger', () => {
  let captured: Array<{ level: LogLevel; formatted: string }> = [];
  const originalFormat = process.env.LOG_FORMAT;
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    captured = [];
    _setWriter((level, formatted) => {
      captured.push({ level, formatted });
    });
  });

  afterEach(() => {
    _resetWriter();
    if (originalFormat !== undefined) process.env.LOG_FORMAT = originalFormat;
    else delete process.env.LOG_FORMAT;
    if (originalLevel !== undefined) process.env.LOG_LEVEL = originalLevel;
    else delete process.env.LOG_LEVEL;
  });

  describe('createLogger', () => {
    it('creates a logger with all four levels', () => {
      const log = createLogger('test');
      expect(log.debug).toBeTypeOf('function');
      expect(log.info).toBeTypeOf('function');
      expect(log.warn).toBeTypeOf('function');
      expect(log.error).toBeTypeOf('function');
    });

    it('emits info messages by default', () => {
      delete process.env.LOG_LEVEL;
      const log = createLogger('dispatch');
      log.info('Dispatch started');
      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('info');
    });

    it('suppresses debug messages by default', () => {
      delete process.env.LOG_LEVEL;
      const log = createLogger('dispatch');
      log.debug('Debug message');
      expect(captured).toHaveLength(0);
    });

    it('emits debug messages when LOG_LEVEL=debug', () => {
      process.env.LOG_LEVEL = 'debug';
      const log = createLogger('dispatch');
      log.debug('Debug message');
      expect(captured).toHaveLength(1);
    });

    it('suppresses info when LOG_LEVEL=warn', () => {
      process.env.LOG_LEVEL = 'warn';
      const log = createLogger('dispatch');
      log.info('Info message');
      log.warn('Warn message');
      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('warn');
    });
  });

  describe('JSON format', () => {
    it('outputs valid JSON with required fields', () => {
      process.env.LOG_FORMAT = 'json';
      const log = createLogger('monitor');
      log.info('Session started', { issueKey: 'RYA-42', role: 'cto' });

      expect(captured).toHaveLength(1);
      const entry = JSON.parse(captured[0].formatted);
      expect(entry.level).toBe('info');
      expect(entry.component).toBe('monitor');
      expect(entry.message).toBe('Session started');
      expect(entry.metadata).toEqual({ issueKey: 'RYA-42', role: 'cto' });
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('omits metadata when empty', () => {
      process.env.LOG_FORMAT = 'json';
      const log = createLogger('dispatch');
      log.warn('No capacity');

      const entry = JSON.parse(captured[0].formatted);
      expect(entry.metadata).toBeUndefined();
    });

    it('omits metadata when passed empty object', () => {
      process.env.LOG_FORMAT = 'json';
      const log = createLogger('dispatch');
      log.info('test', {});

      const entry = JSON.parse(captured[0].formatted);
      expect(entry.metadata).toBeUndefined();
    });
  });

  describe('pretty format', () => {
    it('includes component and message', () => {
      process.env.LOG_FORMAT = 'pretty';
      const log = createLogger('session-manager');
      log.info('Resolved session');

      expect(captured).toHaveLength(1);
      expect(captured[0].formatted).toContain('[session-manager]');
      expect(captured[0].formatted).toContain('Resolved session');
    });

    it('includes metadata as JSON suffix', () => {
      process.env.LOG_FORMAT = 'pretty';
      const log = createLogger('dispatch');
      log.info('Queued', { role: 'cto' });

      expect(captured[0].formatted).toContain('"role":"cto"');
    });
  });

  describe('error routing', () => {
    it('routes error level to error writer', () => {
      const log = createLogger('test');
      log.error('Something failed');
      expect(captured[0].level).toBe('error');
    });

    it('routes warn level to log writer', () => {
      const log = createLogger('test');
      log.warn('Warning');
      expect(captured[0].level).toBe('warn');
    });
  });
});
