/**
 * Serve liveness markers (RYA-1180).
 *
 * serve writes a heartbeat file on every monitor tick and a stop marker on
 * graceful shutdown. A standalone launchd watchdog (scripts/serve-watchdog.sh)
 * — deliberately OUTSIDE this process so it survives serve's death — compares
 * the two to distinguish a crash (heartbeat stale, no newer stop marker) from
 * an intentional CEO pause (stop marker newer than last heartbeat).
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { STATE_DIR } from '../core/config.js';

export const HEARTBEAT_PATH = join(STATE_DIR, 'serve-heartbeat.json');
export const STOP_MARKER_PATH = join(STATE_DIR, 'serve-stopped.json');

/** Write the heartbeat file. Called on startup and every monitor tick (15s). */
export function writeServeHeartbeat(port: number, path: string = HEARTBEAT_PATH): void {
  const now = new Date();
  const payload = JSON.stringify({
    ts: now.getTime(),
    iso: now.toISOString(),
    pid: process.pid,
    port,
  });
  try {
    writeFileSync(path, payload);
  } catch (err) {
    // Heartbeat failure must never kill the monitor loop, but it must not be
    // silent either — a stale heartbeat triggers the watchdog alert.
    console.error(`[liveness] Failed to write heartbeat: ${(err as Error).message}`);
  }
}

/**
 * Write the stop marker on graceful shutdown (SIGINT/SIGTERM, including
 * `launchctl unload`). Auto-deploy restarts (exit 100) bypass this on purpose:
 * they are not a stop, and the heartbeat resumes within seconds.
 */
export function writeServeStopMarker(signal: string, path: string = STOP_MARKER_PATH): void {
  const now = new Date();
  const payload = JSON.stringify({
    ts: now.getTime(),
    iso: now.toISOString(),
    pid: process.pid,
    signal,
    reason: 'clean-shutdown',
  });
  try {
    writeFileSync(path, payload);
  } catch (err) {
    console.error(`[liveness] Failed to write stop marker: ${(err as Error).message}`);
  }
}
