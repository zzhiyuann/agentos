import { afterEach, describe, expect, it } from 'vitest';
import { isCaptureModeEnabled } from './types.js';

const originalEnv = process.env.AOS_CAPTURE_MODE;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.AOS_CAPTURE_MODE;
  } else {
    process.env.AOS_CAPTURE_MODE = originalEnv;
  }
});

describe('isCaptureModeEnabled', () => {
  it('returns false when neither opt nor env is set', () => {
    delete process.env.AOS_CAPTURE_MODE;
    expect(isCaptureModeEnabled({})).toBe(false);
  });

  it('returns true when opts.captureMode is true', () => {
    delete process.env.AOS_CAPTURE_MODE;
    expect(isCaptureModeEnabled({ captureMode: true })).toBe(true);
  });

  it('returns false when opts.captureMode is false even if env is set', () => {
    process.env.AOS_CAPTURE_MODE = '1';
    expect(isCaptureModeEnabled({ captureMode: false })).toBe(false);
  });

  it('returns true when AOS_CAPTURE_MODE=1', () => {
    process.env.AOS_CAPTURE_MODE = '1';
    expect(isCaptureModeEnabled({})).toBe(true);
  });

  it('returns true when AOS_CAPTURE_MODE=true', () => {
    process.env.AOS_CAPTURE_MODE = 'true';
    expect(isCaptureModeEnabled({})).toBe(true);
  });

  it('returns false for other env values (including 0, false, empty)', () => {
    for (const v of ['0', 'false', '', 'no', 'off']) {
      process.env.AOS_CAPTURE_MODE = v;
      expect(isCaptureModeEnabled({})).toBe(false);
    }
  });

  it('opts.captureMode=true wins over AOS_CAPTURE_MODE=0', () => {
    process.env.AOS_CAPTURE_MODE = '0';
    expect(isCaptureModeEnabled({ captureMode: true })).toBe(true);
  });
});
