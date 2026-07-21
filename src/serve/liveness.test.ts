import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeServeHeartbeat, writeServeStopMarker } from './liveness.js';

const WATCHDOG = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/serve-watchdog.sh');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'liveness-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeServeHeartbeat', () => {
  it('writes ts, pid and port', () => {
    const path = join(dir, 'hb.json');
    writeServeHeartbeat(3848, path);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data.port).toBe(3848);
    expect(data.pid).toBe(process.pid);
    expect(data.ts).toBeGreaterThan(Date.now() - 5000);
    expect(data.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not throw when the path is unwritable', () => {
    expect(() => writeServeHeartbeat(3848, join(dir, 'no-such-dir', 'hb.json'))).not.toThrow();
  });
});

describe('writeServeStopMarker', () => {
  it('records the signal and clean-shutdown reason', () => {
    const path = join(dir, 'stop.json');
    writeServeStopMarker('SIGTERM', path);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data.signal).toBe('SIGTERM');
    expect(data.reason).toBe('clean-shutdown');
    expect(data.ts).toBeGreaterThan(Date.now() - 5000);
  });
});

// ─── Watchdog script integration ───
// Drives scripts/serve-watchdog.sh through its state machine using a temp dir
// and the AOS_WD_* env overrides. Discord posts are captured to a file.

interface WatchdogEnv {
  AOS_WD_HB_FILE: string;
  AOS_WD_STOP_FILE: string;
  AOS_WD_STATE_FILE: string;
  AOS_WD_OUTAGE_LOG: string;
  AOS_WD_DISCORD_CAPTURE: string;
  AOS_WD_CANARY_CMD: string;
  AOS_WD_CANARY_STATE_FILE: string;
  AOS_WD_PYEXPAT_CMD: string;
  AOS_WD_PYEXPAT_STATE_FILE: string;
  AOS_WD_STALE_SECS?: string;
  AOS_WD_REALERT_SECS?: string;
  AOS_WD_INTENTIONAL_DELAY_SECS?: string;
  AOS_WD_CANARY_REALERT_SECS?: string;
  AOS_WD_PYEXPAT_REALERT_SECS?: string;
}

function makeEnv(): WatchdogEnv {
  return {
    AOS_WD_HB_FILE: join(dir, 'serve-heartbeat.json'),
    AOS_WD_STOP_FILE: join(dir, 'serve-stopped.json'),
    AOS_WD_STATE_FILE: join(dir, 'watchdog-state.json'),
    AOS_WD_OUTAGE_LOG: join(dir, 'outages.jsonl'),
    AOS_WD_DISCORD_CAPTURE: join(dir, 'discord.txt'),
    AOS_WD_CANARY_CMD: 'true', // hermetic: don't spawn a real node in tests
    AOS_WD_CANARY_STATE_FILE: join(dir, 'node-canary-state'),
    AOS_WD_PYEXPAT_CMD: 'true', // hermetic: don't spawn a real python in tests
    AOS_WD_PYEXPAT_STATE_FILE: join(dir, 'pyexpat-canary-state'),
  };
}

function runWatchdog(env: WatchdogEnv): string {
  return execFileSync('bash', [WATCHDOG], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function alerts(env: WatchdogEnv): string[] {
  if (!existsSync(env.AOS_WD_DISCORD_CAPTURE)) return [];
  return readFileSync(env.AOS_WD_DISCORD_CAPTURE, 'utf8').trim().split('\n').filter(Boolean);
}

function outageEvents(env: WatchdogEnv): Array<Record<string, unknown>> {
  if (!existsSync(env.AOS_WD_OUTAGE_LOG)) return [];
  return readFileSync(env.AOS_WD_OUTAGE_LOG, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

/** Create a file whose mtime is `ageSecs` in the past. */
function touchAged(path: string, ageSecs: number): void {
  writeFileSync(path, '{}');
  const t = new Date(Date.now() - ageSecs * 1000);
  utimesSync(path, t, t);
}

describe('serve-watchdog.sh', () => {
  it('fresh heartbeat → OK, no alert, no outage record', () => {
    const env = makeEnv();
    touchAged(env.AOS_WD_HB_FILE, 60);
    const out = runWatchdog(env);
    expect(out).toContain('OK');
    expect(alerts(env)).toHaveLength(0);
    expect(outageEvents(env)).toHaveLength(0);
    expect(existsSync(env.AOS_WD_STATE_FILE)).toBe(false);
  });

  it('stale heartbeat, no stop marker → crash alert + outage-start marker', () => {
    const env = makeEnv();
    touchAged(env.AOS_WD_HB_FILE, 3600); // 1h stale (> 30 min threshold)
    const out = runWatchdog(env);
    expect(out).toContain('ALERT #1 (crash)');
    const msgs = alerts(env);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('aos-serve is DOWN');
    const events = outageEvents(env);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('outage-start');
    expect(events[0].kind).toBe('crash');
    expect(events[0].last_heartbeat_at).toBeTruthy();
  });

  it('missing heartbeat file entirely → crash alert (dead-man default)', () => {
    const env = makeEnv();
    const out = runWatchdog(env);
    expect(out).toContain('ALERT #1 (crash)');
    const events = outageEvents(env);
    expect(events[0].kind).toBe('crash');
    expect(events[0].last_heartbeat_at).toBeNull();
  });

  it('stale heartbeat WITH newer stop marker → intentional-stop, no immediate alert', () => {
    const env = makeEnv();
    touchAged(env.AOS_WD_HB_FILE, 3600);
    touchAged(env.AOS_WD_STOP_FILE, 3500); // stop marker newer than heartbeat
    const out = runWatchdog(env);
    expect(out).toContain('intentional-stop');
    expect(alerts(env)).toHaveLength(0); // 24h grace before pause reminder
    const events = outageEvents(env);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('intentional-stop');
  });

  it('intentional stop past the grace period → pause reminder fires', () => {
    const env = makeEnv();
    env.AOS_WD_INTENTIONAL_DELAY_SECS = '3000'; // shrink 24h grace below the 1h age
    touchAged(env.AOS_WD_HB_FILE, 3600);
    touchAged(env.AOS_WD_STOP_FILE, 3500);
    runWatchdog(env);
    const msgs = alerts(env);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('paused');
  });

  it('stop marker OLDER than heartbeat → still classified as crash', () => {
    const env = makeEnv();
    touchAged(env.AOS_WD_STOP_FILE, 7200); // old stop from a previous restart
    touchAged(env.AOS_WD_HB_FILE, 3600);   // serve ran again afterwards, then died
    runWatchdog(env);
    expect(outageEvents(env)[0].kind).toBe('crash');
    expect(alerts(env)[0]).toContain('aos-serve is DOWN');
  });

  it('repeat run within re-alert window → no duplicate alert or marker', () => {
    const env = makeEnv();
    touchAged(env.AOS_WD_HB_FILE, 3600);
    runWatchdog(env);
    const out2 = runWatchdog(env);
    expect(out2).toContain('next alert not yet due');
    expect(alerts(env)).toHaveLength(1);
    expect(outageEvents(env)).toHaveLength(1);
  });

  it('repeat run past re-alert window → re-alerts but no duplicate outage-start', () => {
    const env = makeEnv();
    env.AOS_WD_REALERT_SECS = '0'; // every run re-alerts
    touchAged(env.AOS_WD_HB_FILE, 3600);
    runWatchdog(env);
    runWatchdog(env);
    expect(alerts(env)).toHaveLength(2);
    expect(outageEvents(env)).toHaveLength(1); // still one outage
  });

  it('recovery → recovery message + outage-end marker + state cleared', () => {
    const env = makeEnv();
    touchAged(env.AOS_WD_HB_FILE, 3600);
    runWatchdog(env); // outage detected
    touchAged(env.AOS_WD_HB_FILE, 10); // serve came back
    const out = runWatchdog(env);
    expect(out).toContain('Recovery');
    const msgs = alerts(env);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toContain('recovered');
    const events = outageEvents(env);
    expect(events).toHaveLength(2);
    expect(events[1].event).toBe('outage-end');
    expect(events[1].downtime_secs).toBeGreaterThan(3000);
    expect(existsSync(env.AOS_WD_STATE_FILE)).toBe(false);
  });

  it('healthy run after recovery → silent', () => {
    const env = makeEnv();
    touchAged(env.AOS_WD_HB_FILE, 3600);
    runWatchdog(env);
    touchAged(env.AOS_WD_HB_FILE, 10);
    runWatchdog(env); // recovery
    const out = runWatchdog(env); // back to normal
    expect(out).toContain('OK');
    expect(alerts(env)).toHaveLength(2); // no new messages
  });
});

// ─── node restartability canary (RYA-1196) ───

describe('serve-watchdog.sh node canary', () => {
  it('canary fails while serve is healthy → canary alert + node-canary-fail event, heartbeat still OK', () => {
    const env = makeEnv();
    env.AOS_WD_CANARY_CMD = 'echo "dyld: Library not loaded: libllhttp.9.3.dylib"; exit 134';
    touchAged(env.AOS_WD_HB_FILE, 60);
    const out = runWatchdog(env);
    expect(out).toContain('CANARY ALERT');
    expect(out).toContain('OK'); // heartbeat path unaffected
    const msgs = alerts(env);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('restartability canary FAILING');
    expect(msgs[0]).toContain('libllhttp.9.3.dylib');
    const events = outageEvents(env);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('node-canary-fail');
    expect(events[0].error).toContain('libllhttp');
  });

  it('repeat failure within re-alert window → no duplicate alert', () => {
    const env = makeEnv();
    env.AOS_WD_CANARY_CMD = 'false';
    touchAged(env.AOS_WD_HB_FILE, 60);
    runWatchdog(env);
    const out2 = runWatchdog(env);
    expect(out2).toContain('Canary still failing');
    expect(alerts(env)).toHaveLength(1);
    expect(outageEvents(env)).toHaveLength(1);
  });

  it('repeat failure past re-alert window → re-alerts, single fail event', () => {
    const env = makeEnv();
    env.AOS_WD_CANARY_CMD = 'false';
    env.AOS_WD_CANARY_REALERT_SECS = '0';
    touchAged(env.AOS_WD_HB_FILE, 60);
    runWatchdog(env);
    runWatchdog(env);
    expect(alerts(env)).toHaveLength(2);
    expect(outageEvents(env)).toHaveLength(1); // fail event logged once
  });

  it('canary recovery → recovery message + state cleared', () => {
    const env = makeEnv();
    env.AOS_WD_CANARY_CMD = 'false';
    touchAged(env.AOS_WD_HB_FILE, 60);
    runWatchdog(env);
    env.AOS_WD_CANARY_CMD = 'true';
    const out = runWatchdog(env);
    expect(out).toContain('Canary recovery');
    const msgs = alerts(env);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toContain('canary passing again');
    expect(existsSync(env.AOS_WD_CANARY_STATE_FILE)).toBe(false);
    const events = outageEvents(env);
    expect(events[1].event).toBe('node-canary-recovered');
  });

  it('canary failure does not mask a serve-down alert — both fire', () => {
    const env = makeEnv();
    env.AOS_WD_CANARY_CMD = 'false';
    touchAged(env.AOS_WD_HB_FILE, 3600); // serve also down
    const out = runWatchdog(env);
    expect(out).toContain('CANARY ALERT');
    expect(out).toContain('ALERT #1 (crash)');
    const msgs = alerts(env);
    expect(msgs).toHaveLength(2);
    expect(msgs.some(m => m.includes('canary FAILING'))).toBe(true);
    expect(msgs.some(m => m.includes('aos-serve is DOWN'))).toBe(true);
  });
});

// ─── brew-python pyexpat canary (RYA-1203) ───

describe('serve-watchdog.sh pyexpat canary', () => {
  it('pyexpat fails while serve is healthy → alert + pyexpat-canary-fail event, heartbeat still OK', () => {
    const env = makeEnv();
    env.AOS_WD_PYEXPAT_CMD =
      'echo "ImportError: dlopen(pyexpat.cpython-314-darwin.so): symbol not found _XML_SetAllocTrackerActivationThreshold"; exit 1';
    touchAged(env.AOS_WD_HB_FILE, 60);
    const out = runWatchdog(env);
    expect(out).toContain('PYEXPAT ALERT');
    expect(out).toContain('OK'); // heartbeat path unaffected
    const msgs = alerts(env);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('pyexpat canary FAILING');
    expect(msgs[0]).toContain('_XML_SetAllocTrackerActivationThreshold');
    expect(msgs[0]).toContain('brew-python-pyexpat-breaks-node-gyp');
    // Distinct severity from the node canary: must NOT claim restarts break.
    expect(msgs[0]).toContain('restarts are NOT affected');
    expect(msgs[0]).not.toContain('restart will brick');
    const events = outageEvents(env);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('pyexpat-canary-fail');
    expect(events[0].error).toContain('_XML_SetAllocTracker');
  });

  it('repeat failure within re-alert window → no duplicate alert', () => {
    const env = makeEnv();
    env.AOS_WD_PYEXPAT_CMD = 'false';
    touchAged(env.AOS_WD_HB_FILE, 60);
    runWatchdog(env);
    const out2 = runWatchdog(env);
    expect(out2).toContain('Pyexpat canary still failing');
    expect(alerts(env)).toHaveLength(1);
    expect(outageEvents(env)).toHaveLength(1);
  });

  it('repeat failure past re-alert window → re-alerts, single fail event', () => {
    const env = makeEnv();
    env.AOS_WD_PYEXPAT_CMD = 'false';
    env.AOS_WD_PYEXPAT_REALERT_SECS = '0';
    touchAged(env.AOS_WD_HB_FILE, 60);
    runWatchdog(env);
    runWatchdog(env);
    expect(alerts(env)).toHaveLength(2);
    expect(outageEvents(env)).toHaveLength(1); // fail event logged once
  });

  it('pyexpat recovery → recovery message + state cleared', () => {
    const env = makeEnv();
    env.AOS_WD_PYEXPAT_CMD = 'false';
    touchAged(env.AOS_WD_HB_FILE, 60);
    runWatchdog(env);
    env.AOS_WD_PYEXPAT_CMD = 'true';
    const out = runWatchdog(env);
    expect(out).toContain('Pyexpat canary recovery');
    const msgs = alerts(env);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toContain('pyexpat canary passing again');
    expect(existsSync(env.AOS_WD_PYEXPAT_STATE_FILE)).toBe(false);
    const events = outageEvents(env);
    expect(events[1].event).toBe('pyexpat-canary-recovered');
  });

  it('node and pyexpat canaries are independent — both fail, two distinct alerts and state files', () => {
    const env = makeEnv();
    env.AOS_WD_CANARY_CMD = 'false';
    env.AOS_WD_PYEXPAT_CMD = 'false';
    touchAged(env.AOS_WD_HB_FILE, 60);
    const out = runWatchdog(env);
    expect(out).toContain('CANARY ALERT');
    expect(out).toContain('PYEXPAT ALERT');
    const msgs = alerts(env);
    expect(msgs).toHaveLength(2);
    const nodeMsg = msgs.find(m => m.includes('restartability canary FAILING'));
    const pyMsg = msgs.find(m => m.includes('pyexpat canary FAILING'));
    expect(nodeMsg).toBeTruthy();
    expect(pyMsg).toBeTruthy();
    expect(nodeMsg).toContain('restart will brick');
    expect(pyMsg).not.toContain('restart will brick');
    expect(existsSync(env.AOS_WD_CANARY_STATE_FILE)).toBe(true);
    expect(existsSync(env.AOS_WD_PYEXPAT_STATE_FILE)).toBe(true);
    const events = outageEvents(env);
    expect(events.map(e => e.event).sort()).toEqual(['node-canary-fail', 'pyexpat-canary-fail']);
  });

  it('pyexpat recovery does not clear a still-failing node canary', () => {
    const env = makeEnv();
    env.AOS_WD_CANARY_CMD = 'false';
    env.AOS_WD_PYEXPAT_CMD = 'false';
    touchAged(env.AOS_WD_HB_FILE, 60);
    runWatchdog(env); // both fail
    env.AOS_WD_PYEXPAT_CMD = 'true';
    const out = runWatchdog(env);
    expect(out).toContain('Pyexpat canary recovery');
    expect(out).toContain('Canary still failing');
    expect(existsSync(env.AOS_WD_CANARY_STATE_FILE)).toBe(true);
    expect(existsSync(env.AOS_WD_PYEXPAT_STATE_FILE)).toBe(false);
  });
});
