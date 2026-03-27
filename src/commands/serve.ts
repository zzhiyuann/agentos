/**
 * AgentOS serve command — HTTP server + monitor loop.
 * This is the thin orchestrator; handlers live in src/serve/.
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHmac } from 'crypto';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { sessionExists, sendKeys } from '../core/tmux.js';
import { listAgents, loadAgentConfig } from '../core/persona.js';
import { getActiveAttempts, getRecentEvents, closeDb, backupDb } from '../core/db.js';
import { getQueueItems, cleanupQueue } from '../core/queue.js';

// Re-export pure functions for tests and backwards compatibility
export { classifyEvent, routeEvent, type EventClassification, type RouteDecision } from '../serve/classify.js';
export { countConsecutiveRateLimitFailures, getRateLimitBackoffMs } from '../serve/helpers.js';

import { classifyEvent } from '../serve/classify.js';
import { handleWebhook } from '../serve/webhook.js';
import { handleCommentCreated } from '../serve/comments.js';
import { handleIssueCreated, handleIssueUpdated } from '../serve/issues.js';
import { handleDispatch } from '../serve/dispatch.js';
import { getDashboardHtml } from '../serve/dashboard.js';
import { postToGroupChat } from '../serve/helpers.js';
import { monitorSessions } from '../serve/monitor.js';
import {
  autoDispatchFromBacklog, heartbeatAssignUnowned, drainQueue,
  pollOrphanedIssues, reconcileInProgressIssues, janitorAgentSessions,
  checkMailboxResponses, projectPipelineHeartbeat,
} from '../serve/scheduler.js';
import {
  markServeStarted, getSystemConcurrencyStatus,
  hibernateByIssueKey, wakeByIssueKey,
} from '../serve/concurrency.js';
import { startDiscordBot, stopDiscordBot, sendDiscordReply } from '../serve/discord-bot.js';
import { startAutoDeployWatcher } from '../serve/auto-deploy.js';
import { planAndDispatch, getSubIssues } from '../serve/planner.js';
import { scanParentIssues, cleanupParentTracker } from '../serve/parent-tracker.js';
import { monitorSwarms, getSwarmDashboardData } from '../serve/swarm-monitor.js';

const PORT = 3848;

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

/** Verify Linear webhook signature (HMAC-SHA256). Returns true if valid or verification is disabled. */
export function verifyWebhookSignature(body: string, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true; // Verification disabled — no secret configured
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function serveCommand(options: { port?: number; noAutoDeploy?: boolean }): Promise<void> {
  const port = options.port || PORT;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // ─── GET routes ───

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agent: 'AgentOS' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const agents = listAgents().map(role => {
        const tmuxName = `aos-${role}`;
        const running = sessionExists(tmuxName);
        const config = loadAgentConfig(role);
        const active = getActiveAttempts().find(a => a.agent_type === role);
        return {
          role,
          model: config.baseModel,
          status: running ? 'active' : 'idle',
          currentTask: active?.issue_key || null,
          tmuxSession: running ? tmuxName : null,
        };
      });
      const queueItems = getQueueItems();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        company: 'AgentOS',
        uptime: Math.round(process.uptime()),
        agents,
        queue: { length: queueItems.length, items: queueItems.map(q => ({ issueKey: q.issue_key, role: q.agent_role })) },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHtml());
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/events')) {
      const url = new URL(req.url, `http://localhost`);
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const events = getRecentEvents(limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events));
      return;
    }

    if (req.method === 'GET' && req.url === '/swarm-status') {
      const swarms = getSwarmDashboardData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ swarms }));
      return;
    }

    // Open terminal redirect
    const openMatch = req.url?.match(/^\/open\/([A-Z]+-\d+)/);
    if (req.method === 'GET' && openMatch) {
      const issueKey = openMatch[1];
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html><head>
<title>AgentOS · ${issueKey}</title>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, sans-serif; display: flex; justify-content: center;
    align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0; }
  .card { text-align: center; padding: 2.5rem; }
  h2 { color: #6366f1; margin-bottom: 1.5rem; }
  .btn { display: inline-block; padding: 14px 36px; background: #6366f1; color: white;
    text-decoration: none; border-radius: 8px; font-size: 1.1rem; font-weight: 600;
    transition: background 0.2s; }
  .btn:hover { background: #4f46e5; }
  .hint { color: #666; font-size: 0.8rem; margin-top: 1.5rem; }
  code { background: #2a2a3e; padding: 2px 6px; border-radius: 3px; }
</style>
</head><body>
<div class="card">
  <h2>AgentOS · ${issueKey}</h2>
  <a class="btn" href="agentos://session/${issueKey}">Open Terminal</a>
  <p class="hint">Or run: <code>aos jump ${issueKey}</code></p>
</div>
</body></html>`);
      return;
    }

    // ─── POST routes ───

    if (req.method === 'POST' && req.url === '/company/start') {
      try {
        const { companyStartCommand } = await import('./company.js');
        await companyStartCommand();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, detail: 'Company started' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/company/stop') {
      try {
        const { companyStopCommand } = await import('./company.js');
        await companyStopCommand({ force: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, detail: 'Company stopped' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/ask') {
      const body = await readBody(req);
      try {
        const { from, to, issueKey, question } = JSON.parse(body);
        if (!to || !question) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing to or question' }));
          return;
        }
        const ts = new Date().toLocaleTimeString();
        console.log(chalk.blue(`[${ts}] Ask: ${from} → ${to}: "${question.substring(0, 60)}"`));
        const { sendMessage } = await import('../core/mailbox.js');
        const msgId = `${Date.now()}-${from}`;
        sendMessage({ id: msgId, from, to, issueKey, type: 'ask', content: question, timestamp: new Date().toISOString() });
        const tmuxName = `aos-${to}`;
        if (sessionExists(tmuxName)) {
          try { sendKeys(tmuxName, `[ASK from ${from}] ${question}. Reply by writing to ~/.aos/mailbox/${to}/outbox/${msgId}.json with: echo '{"response":"your answer"}' > ~/.aos/mailbox/${to}/outbox/${msgId}.json`); } catch { /**/ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action: 'sent', detail: `Question sent to ${to}.` }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/notify') {
      const body = await readBody(req);
      try {
        const { from, to, message } = JSON.parse(body);
        if (!to || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing to or message' }));
          return;
        }
        const ts = new Date().toLocaleTimeString();
        console.log(chalk.blue(`[${ts}] Notify: ${from} → ${to}: "${message.substring(0, 60)}"`));
        const tmuxName = `aos-${to}`;
        if (sessionExists(tmuxName)) {
          try { sendKeys(tmuxName, `[NOTIFY from ${from}]: ${message}`); } catch { /**/ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, detail: `Notified ${to}` }));
        } else {
          const { sendMessage } = await import('../core/mailbox.js');
          sendMessage({ id: `${Date.now()}-${from}`, from, to, type: 'notify', content: message, timestamp: new Date().toISOString() });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, detail: `${to} is idle, message saved to mailbox` }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/dispatch') {
      const body = await readBody(req);
      try {
        const result = await handleDispatch(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, action: 'error', detail: (err as Error).message }));
      }
      return;
    }

    // Discord reply — agents call this to reply in Discord conversations
    if (req.method === 'POST' && req.url === '/discord-reply') {
      const body = await readBody(req);
      try {
        const { channelId, messageId, content, role } = JSON.parse(body);
        if (!channelId || !content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing channelId or content' }));
          return;
        }
        const sent = await sendDiscordReply(channelId, content, role, messageId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: sent }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    // Progress reporting — called by Claude Code Stop hook to push updates to Linear
    if (req.method === 'POST' && req.url === '/progress') {
      const body = await readBody(req);
      try {
        const { role, message } = JSON.parse(body);
        if (!role || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing role or message' }));
          return;
        }
        const { emitActivity } = await import('../core/linear.js');
        const { getAgentLinearToken } = await import('../core/persona.js');
        const attempts = getActiveAttempts().filter(a => a.agent_type === role && a.status === 'running');
        let emitted = false;
        for (const attempt of attempts) {
          if (attempt.agent_session_id) {
            const token = getAgentLinearToken(role) || undefined;
            try {
              await emitActivity(attempt.agent_session_id, {
                type: 'thought',
                body: message.substring(0, 500),
              }, true, token);
              emitted = true;
            } catch { /**/ }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, emitted }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/group-message') {
      const body = await readBody(req);
      try {
        const { from, text } = JSON.parse(body);
        const { parseMentions } = await import('../core/telegram.js');
        const { parseDiscordMentions } = await import('../core/discord.js');
        const mentions = [...new Set([...parseMentions(text), ...parseDiscordMentions(text)])];
        const ts = new Date().toLocaleTimeString();
        console.log(chalk.blue(`[${ts}] Group: ${from}: "${text.substring(0, 60)}" → ${mentions.join(', ') || 'no mentions'}`));
        for (const role of mentions) {
          const tmuxName = `aos-${role}`;
          if (sessionExists(tmuxName)) {
            try { sendKeys(tmuxName, `[GROUP from ${from}]: ${text}`); } catch { /**/ }
          } else {
            const { sendMessage } = await import('../core/mailbox.js');
            sendMessage({ id: `tg-${Date.now()}-${from}`, from: from || 'group', to: role, type: 'notify', content: text, timestamp: new Date().toISOString() });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, routed: mentions }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/group-post') {
      const body = await readBody(req);
      try {
        const { role, message } = JSON.parse(body);
        const sent = await postToGroupChat(role || 'system', message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: sent }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    // ─── Plan + Decompose endpoint ───
    if (req.method === 'POST' && req.url === '/plan') {
      const body = await readBody(req);
      try {
        const { issueKey } = JSON.parse(body);
        if (!issueKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing issueKey' }));
          return;
        }
        const ts = new Date().toLocaleTimeString();
        console.log(chalk.bold(`[${ts}] Plan request: ${issueKey}`));

        // Run planning asynchronously — respond immediately
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action: 'planning', detail: `Planning ${issueKey}...` }));

        // Execute plan + dispatch in background
        planAndDispatch(issueKey).catch(err => {
          console.log(chalk.red(`Planning failed for ${issueKey}: ${(err as Error).message}`));
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    // ─── Sub-issues query endpoint ───
    if (req.method === 'GET' && req.url?.startsWith('/sub-issues/')) {
      const match = req.url.match(/^\/sub-issues\/([A-Z]+-\d+)/);
      if (match) {
        try {
          const subIssues = await getSubIssues(match[1]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, parentKey: match[1], subIssues }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
        return;
      }
    }

    // ─── Concurrency management endpoints ───
    if (req.method === 'GET' && req.url === '/concurrency') {
      const status = getSystemConcurrencyStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (req.method === 'POST' && req.url === '/hibernate') {
      const body = await readBody(req);
      try {
        const { issueKey } = JSON.parse(body);
        if (!issueKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing issueKey' }));
          return;
        }
        const result = hibernateByIssueKey(issueKey);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/wake') {
      const body = await readBody(req);
      try {
        const { issueKey } = JSON.parse(body);
        if (!issueKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing issueKey' }));
          return;
        }
        const result = wakeByIssueKey(issueKey);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    // ─── Webhook endpoint ───
    if (req.method === 'POST' && (req.url === '/webhook' || req.url === '/')) {
      const body = await readBody(req);
      const webhookSecret = process.env.AOS_WEBHOOK_SECRET;
      const signature = req.headers['linear-signature'] as string | undefined;
      if (!verifyWebhookSignature(body, signature, webhookSecret)) {
        console.log(chalk.red('Webhook signature verification failed — rejecting request'));
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      try {
        const payload = JSON.parse(body);
        console.log(chalk.dim(`  webhookId=${payload.webhookId || 'none'} action=${payload.action}`));
        const event = req.headers['linear-event'] as string || 'unknown';
        const ts = new Date().toLocaleTimeString();
        console.log(chalk.bold(`[${ts}] ${event}: ${payload.action}`));

        const eventClass = classifyEvent(event, payload);
        switch (eventClass) {
          case 'agent-session':
            await handleWebhook(payload);
            break;
          case 'comment-mention':
            await handleCommentCreated(payload);
            break;
          case 'issue-created':
            await handleIssueCreated(payload);
            break;
          case 'issue-updated':
            await handleIssueUpdated(payload);
            break;
          default:
            console.log(chalk.dim(`  [LOG] ${event}:${payload.action} — no spawn triggered`));
        }
      } catch (err) {
        console.log(chalk.red(`Webhook error: ${(err as Error).message}`));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // ─── Monitor loop ───
  const POLL_INTERVAL_MS = 15_000;

  async function monitorLoop(): Promise<void> {
    try {
      await monitorSessions();
      await drainQueue();
      await autoDispatchFromBacklog();
      await heartbeatAssignUnowned();
      await pollOrphanedIssues();
      await reconcileInProgressIssues();
      await janitorAgentSessions();
      await checkMailboxResponses();
      cleanupQueue();
      await scanParentIssues();
      cleanupParentTracker();
      await monitorSwarms();
      await projectPipelineHeartbeat();
    } catch (err) {
      console.log(chalk.red(`Monitor error: ${(err as Error).message}`));
    }
  }

  server.listen(port, async () => {
    markServeStarted(); // Anchor restart cooldown timer (prevents dispatch storm)
    console.log(chalk.bold('AgentOS Webhook Server + Monitor'));
    console.log(`Listening on http://localhost:${port}`);
    console.log(`Session monitor: every ${POLL_INTERVAL_MS / 1000}s`);

    // Start Discord bot if configured
    const discordStarted = await startDiscordBot();
    if (discordStarted) {
      console.log('Discord bot: connected (bidirectional)');
    }

    // Start auto-deploy watcher (rebuilds + restarts on src/ changes)
    if (!options.noAutoDeploy) {
      startAutoDeployWatcher();
    } else {
      console.log('Auto-deploy: disabled');
    }

    console.log('Press Ctrl+C to stop\n');
  });

  // Graceful shutdown — checkpoint WAL + close DB to prevent 0-byte corruption
  const gracefulShutdown = (signal: string) => {
    console.log(chalk.dim(`\n[${signal}] Shutting down gracefully...`));
    stopDiscordBot();
    closeDb(); // WAL checkpoint + close
    process.exit(0);
  };
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Periodic DB backup — every 30 minutes
  setInterval(() => { backupDb(); }, 30 * 60_000);

  setInterval(monitorLoop, POLL_INTERVAL_MS);
}
