#!/usr/bin/env npx tsx
/**
 * One-time script to retroactively post HANDOFF.md content as comments
 * on Linear issues where the handoff was written but never posted.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { getIssue, addComment, getRecentCommentBodies } from '../src/core/linear.js';

import { homedir } from 'os';

const WORKSPACES_DIR = process.env.AOS_WORKSPACE_BASE?.replace(/^~/, homedir())
  || join(homedir(), 'agent-workspaces');

async function main() {
  const entries = readdirSync(WORKSPACES_DIR, { withFileTypes: true });
  const issueKeys = entries
    .filter(e => e.isDirectory() && /^RYA-\d+$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1]));

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const key of issueKeys) {
    const handoffPath = join(WORKSPACES_DIR, key, 'HANDOFF.md');
    if (!existsSync(handoffPath)) continue;

    const handoff = readFileSync(handoffPath, 'utf-8');
    if (!handoff.trim()) {
      console.log(`SKIP ${key}: empty HANDOFF.md`);
      skipped++;
      continue;
    }

    try {
      // Get the issue to verify it exists and get the ID
      const issue = await getIssue(key);

      // Check if handoff is already posted as a comment (first 200 chars fingerprint)
      const recentBodies = await getRecentCommentBodies(issue.id, 10);
      const fingerprint = handoff.substring(0, 200);
      const alreadyPosted = recentBodies.some(body => body.includes(fingerprint));

      if (alreadyPosted) {
        console.log(`SKIP ${key}: handoff already in comments`);
        skipped++;
        continue;
      }

      // Post the handoff as a comment
      await addComment(issue.id, handoff);
      console.log(`POST ${key}: "${issue.title}" (${handoff.length} chars)`);
      posted++;

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`FAIL ${key}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${posted} posted, ${skipped} skipped, ${failed} failed`);
}

main().catch(console.error);
