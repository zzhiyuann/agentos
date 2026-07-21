/**
 * RYA-1206: Pending handoff-actions journal.
 *
 * The monitor's completion sequence is not atomic — an auto-deploy restart
 * (exit 100) can kill serve after the HANDOFF content-hash is claimed and the
 * attempt is marked completed, but before the structured actions declared in
 * HANDOFF.md front matter (dispatches, delegate, parent_status,
 * review_dispatch) are applied. RYA-1204 made the scheduler reconciler recover
 * the *status* half; this journal recovers the *actions* half:
 *
 *   1. The monitor journals the parsed+validated actions to disk BEFORE any
 *      completion side effects (Discord posts, summary comment, doc upload).
 *   2. The entry is acked (deleted) only after the actions have been executed.
 *   3. Un-acked entries are replayed once on serve startup
 *      (monitor.replayPendingHandoffActions) — at-least-once delivery;
 *      handleDispatch's persistent dedup and the `handoff-actions:<attemptId>`
 *      dedup marker keep replays idempotent.
 *
 * Entries expire after 24h so a permanently failing entry can't replay forever.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../core/logger.js';
import type { HandoffActions } from './monitor.js';

const log = createLogger('action-journal');

/** Journal entries older than this are dropped on read instead of replayed. */
export const PENDING_ACTIONS_MAX_AGE_MS = 24 * 60 * 60_000;

export interface PendingActionsEntry {
  version: 1;
  attemptId: string;
  issueKey: string;
  issueId: string;
  agentType: string;
  isFollowUp: boolean;
  /** Post-validation actions (output of validateHandoffActions). */
  actions: HandoffActions;
  /** Full HANDOFF.md content — replay needs it for reviewer tier classification. */
  handoff: string;
  createdAt: number;
}

/**
 * Resolved lazily (not at module load) so tests can redirect via
 * AOS_PENDING_ACTIONS_DIR and so importing this module never touches the
 * filesystem. Lives beside the per-issue state dirs (~/.aos/work/<ISSUE-KEY>);
 * the underscore prefix can't collide with Linear issue keys.
 */
function journalDir(): string {
  const dir = process.env.AOS_PENDING_ACTIONS_DIR
    || join(homedir(), '.aos', 'work', '_pending-actions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function entryPath(dir: string, attemptId: string): string {
  // Attempt IDs are UUIDs; sanitize defensively so a bad ID can't escape the dir.
  return join(dir, `${attemptId.replace(/[^\w-]/g, '_')}.json`);
}

/** Persist a pending-actions entry. Atomic (write tmp + rename) so a crash
 *  mid-write can never leave a torn JSON file behind. */
export function journalPendingActions(entry: PendingActionsEntry): void {
  const path = entryPath(journalDir(), entry.attemptId);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, path);
}

/** Remove an entry after its actions have been executed. Idempotent. */
export function ackPendingActions(attemptId: string): void {
  try {
    unlinkSync(entryPath(journalDir(), attemptId));
  } catch {
    // Already acked / never journaled — fine either way.
  }
}

/** Read all replayable entries. Expired, corrupt, and malformed files are
 *  deleted on sight so they can't accumulate or poison future replays. */
export function listPendingActions(): PendingActionsEntry[] {
  const dir = journalDir();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    log.debug('Journal dir unreadable', { dir, error: (err as Error).message });
    return [];
  }
  const cutoff = Date.now() - PENDING_ACTIONS_MAX_AGE_MS;
  const entries: PendingActionsEntry[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue; // skips .tmp debris from a crash mid-write
    const path = join(dir, file);
    try {
      const entry = JSON.parse(readFileSync(path, 'utf-8')) as PendingActionsEntry;
      if (!entry?.attemptId || !entry?.issueKey || !entry?.actions) {
        unlinkSync(path);
        continue;
      }
      if ((entry.createdAt || 0) < cutoff) {
        unlinkSync(path);
        continue;
      }
      entries.push(entry);
    } catch (err) {
      log.warn('Dropping corrupt journal entry', { file, error: (err as Error).message });
      try {
        unlinkSync(path);
      } catch (unlinkErr) {
        log.debug('Failed to delete corrupt journal entry', { file, error: (unlinkErr as Error).message });
      }
    }
  }
  return entries;
}
