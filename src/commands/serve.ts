/**
 * AgentOS serve command — HTTP server + monitor loop.
 * This is the thin orchestrator; handlers live in src/serve/.
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHmac } from 'crypto';
import { existsSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { sessionExists, sendKeys } from '../core/tmux.js';
import { listAgents, loadAgentConfig } from '../core/persona.js';
import { getActiveAttempts, getRecentEvents, closeDb, backupDb, purgeOldEvents } from '../core/db.js';
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
import { monitorSessions, replayPendingHandoffActions } from '../serve/monitor.js';
import {
  autoDispatchFromBacklog, heartbeatAssignUnowned, drainQueue,
  pollOrphanedIssues, reconcileInProgressIssues, janitorAgentSessions,
  checkMailboxResponses, projectPipelineHeartbeat, ceoOfficeTriageHeartbeat,
  ceoOfficeDailyDispatch, weeklyPnLDigestHeartbeat, costAttributionHeartbeat,
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
import { validateAndRefreshAllTokens, forceTokenCheck } from '../serve/token-health.js';
import { proactiveChannelHeartbeat, scanProactiveIdeas } from '../serve/proactive.js';
import { writeServeHeartbeat, writeServeStopMarker } from '../serve/liveness.js';

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

  // Read version from package.json
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
  } catch { /* fallback to 'unknown' */ }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // ─── GET routes ───

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agent: 'AgentOS' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/ping') {
      const activeAttempts = getActiveAttempts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        activeAgents: activeAttempts.length,
        timestamp: new Date().toISOString(),
      }));
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

    // ─── CEO Portal — mobile-first, Chinese, the single address for the boss ───
    // Reachable over Tailscale: http://<AOS_HOST>:3848/ceo
    if (req.method === 'GET' && (req.url === '/ceo' || req.url === '/ceo/' || req.url === '/')) {
      try {
        const home = homedir();
        const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Recent deliverables: ~/.aos/work/*/HANDOFF.md, last 7 days, boss-readable excerpt
        const workDir = join(home, '.aos', 'work');
        const items: { key: string; mtime: number; boss: string }[] = [];
        if (existsSync(workDir)) {
          for (const d of readdirSync(workDir)) {
            const hp = join(workDir, d, 'HANDOFF.md');
            try {
              const st = statSync(hp);
              if (Date.now() - st.mtimeMs > 7 * 24 * 60 * 60 * 1000) continue;
              const md = readFileSync(hp, 'utf-8');
              const boss = md.match(/## 给老板的话\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim()
                || md.match(/## Summary\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() || '';
              items.push({ key: d, mtime: st.mtimeMs, boss: boss.substring(0, 300) });
            } catch { /* unreadable entry — skip */ }
          }
        }
        items.sort((a, b) => b.mtime - a.mtime);

        // Briefs: ~/claude-briefs/*.html
        const briefsDir = join(home, 'claude-briefs');
        const briefs = existsSync(briefsDir)
          ? readdirSync(briefsDir).filter(f => f.endsWith('.html'))
              .map(f => ({ f, m: statSync(join(briefsDir, f)).mtimeMs }))
              .sort((a, b) => b.m - a.m).slice(0, 12)
          : [];

        // Today's spend, broken down by agent role
        let todayCost = 0;
        const roleCosts: Map<string, number> = new Map();
        try {
          const { getAttributionsSince } = await import('../core/db.js');
          const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
          for (const a of getAttributionsSince(dayStart.toISOString())) {
            const cost = (a.task_cost_usd || 0) + (a.meta_cost_usd || 0);
            todayCost += cost;
            roleCosts.set(a.role, (roleCosts.get(a.role) || 0) + cost);
          }
        } catch { /* cost unavailable — show 0 */ }

        // Per-agent cost card: top 4 roles by spend, descending
        const topRoles = [...roleCosts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4);
        const agentCostSection = topRoles.length > 0
          ? `<h2>今日各 Agent 花费</h2>
<div class="cost-row">
${topRoles.map(([role, cost]) =>
  `  <div class="cost-chip"><span class="cost-role">${esc(role)}</span><span class="cost-usd">$${cost.toFixed(2)}</span></div>`
).join('\n')}
</div>`
          : `<h2>今日各 Agent 花费</h2><div class="dim cost-na">成本数据采集中</div>`;

        const fmtTime = (ms: number) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const deliverRows = items.slice(0, 15).map(i =>
          `<a class="item" href="/docs/${encodeURIComponent(i.key)}/HANDOFF.md">
            <div class="k">${esc(i.key)} <span class="t">${fmtTime(i.mtime)}</span></div>
            <div class="b">${esc(i.boss) || '<span class="dim">（无摘要）</span>'}</div>
          </a>`).join('\n');
        const briefRows = briefs.map(b =>
          `<a class="item" href="/briefs/${encodeURIComponent(b.f)}">
            <div class="k">${esc(b.f.replace('.html', ''))} <span class="t">${fmtTime(b.m)}</span></div>
          </a>`).join('\n');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentOS CEO 门户</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; max-width: 680px; margin: 0 auto;
    padding: 18px 14px 60px; background: #0f1117; color: #e8eaf0; line-height: 1.6; }
  h1 { font-size: 21px; margin-bottom: 2px; }
  .sub { color: #9aa1b5; font-size: 13px; margin-bottom: 18px; }
  h2 { font-size: 15px; color: #e8a849; margin: 22px 0 10px; }
  .row { display: flex; gap: 10px; margin-bottom: 14px; }
  .stat { flex: 1; background: #181b24; border: 1px solid #2a2f40; border-radius: 12px; padding: 12px; text-align: center; }
  .stat .n { font-size: 19px; font-weight: 700; color: #e8a849; }
  .stat .l { font-size: 11px; color: #9aa1b5; }
  .item { display: block; background: #181b24; border: 1px solid #2a2f40; border-radius: 12px;
    padding: 12px 14px; margin-bottom: 10px; text-decoration: none; color: inherit; }
  .item:active { background: #1e2230; }
  .k { font-weight: 600; font-size: 14px; color: #93c5fd; }
  .t { float: right; font-weight: 400; font-size: 12px; color: #9aa1b5; }
  .b { font-size: 13px; color: #c8cdd9; margin-top: 4px; }
  .dim { color: #6a7188; }
  .links a { display: inline-block; background: #1e2230; border: 1px solid #2a2f40; color: #e8eaf0;
    border-radius: 99px; padding: 7px 16px; margin: 0 8px 8px 0; text-decoration: none; font-size: 13px; }
  .cost-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .cost-chip { display: flex; flex-direction: column; align-items: center; background: #181b24;
    border: 1px solid #2a2f40; border-radius: 12px; padding: 10px 16px; min-width: 80px; flex: 1; }
  .cost-role { font-size: 12px; color: #9aa1b5; text-transform: uppercase; letter-spacing: 0.05em; }
  .cost-usd { font-size: 18px; font-weight: 700; color: #e8a849; margin-top: 2px; }
  .cost-na { font-size: 13px; margin-bottom: 14px; }
</style></head><body>
<h1>📋 AgentOS CEO 门户</h1>
<div class="sub">公司一切交付的统一入口 · 经 Tailscale 访问 · 自动刷新最近 7 天</div>
<div class="row">
  <div class="stat"><div class="n">$${todayCost.toFixed(2)}</div><div class="l">今日算力（订阅内·名义值）</div></div>
  <div class="stat"><div class="n">${items.length}</div><div class="l">7 天交付</div></div>
  <div class="stat"><div class="n">${briefs.length}</div><div class="l">简报</div></div>
</div>
<h2>快捷入口</h2>
<div class="links">
  <a href="http://<AOS_HOST>:3000">📚 今日新书</a>
  <a href="/dashboard">📊 运行面板</a>
  <a href="https://linear.app/ryanhub">📥 Linear 待审</a>
</div>
${agentCostSection}
<h2>最近交付（点开看详情）</h2>
${deliverRows || '<div class="dim">最近 7 天暂无交付</div>'}
<h2>分析简报</h2>
${briefRows || '<div class="dim">暂无简报</div>'}
</body></html>`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Portal error: ' + (err as Error).message);
      }
      return;
    }

    // ─── Briefs — serve ~/claude-briefs/*.html (path-traversal safe) ───
    if (req.method === 'GET' && req.url?.startsWith('/briefs/')) {
      const name = basename(decodeURIComponent(req.url.slice(8)));
      const fp = join(homedir(), 'claude-briefs', name);
      if (!name.endsWith('.html') || !existsSync(fp)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Brief not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(fp, 'utf-8'));
      return;
    }

    // ─── Docs viewer — serve markdown as mobile-friendly HTML ───
    if (req.method === 'GET' && req.url?.startsWith('/docs/')) {
      const docPath = decodeURIComponent(req.url.slice(6)); // strip /docs/
      // Resolve: try agent-workspaces, then .aos/work, then absolute
      const candidates = [
        join(homedir(), 'agent-workspaces', docPath),
        join(homedir(), '.aos/work', docPath),
        docPath.startsWith('/') ? docPath : join(homedir(), docPath),
      ];
      const filePath = candidates.find(p => existsSync(p));
      if (!filePath || !filePath.endsWith('.md')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Document not found');
        return;
      }
      try {
        const md = readFileSync(filePath, 'utf-8');
        const title = md.match(/^#\s+(.+)/m)?.[1] || docPath.split('/').pop() || 'Document';
        // Simple markdown to HTML: headers, bold, italic, code, bullets, links
        const html = md
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/^### (.+)$/gm, '<h3>$1</h3>')
          .replace(/^## (.+)$/gm, '<h2>$1</h2>')
          .replace(/^# (.+)$/gm, '<h1>$1</h1>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/^- (.+)$/gm, '<li>$1</li>')
          .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
          .replace(/\n\n/g, '</p><p>')
          .replace(/\n/g, '<br>');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 0 auto;
    padding: 16px; background: #1a1a2e; color: #e0e0e0; line-height: 1.6; font-size: 16px; }
  h1 { color: #6366f1; font-size: 1.5em; border-bottom: 1px solid #333; padding-bottom: 8px; }
  h2 { color: #818cf8; font-size: 1.25em; margin-top: 1.5em; }
  h3 { color: #a5b4fc; font-size: 1.1em; }
  code { background: #2a2a3e; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #2a2a3e; padding: 12px; border-radius: 6px; overflow-x: auto; }
  li { margin: 4px 0; }
  strong { color: #f0f0f0; }
  a { color: #6366f1; }
  p { margin: 0.5em 0; }
</style>
</head><body><p>${html}</p></body></html>`);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to read document');
      }
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
        const parsed = JSON.parse(body);
        // HTTP dispatch is always explicit (via linear-tool or API) — bypass recently-completed check
        parsed.skipCompletionCheck = true;
        const result = await handleDispatch(parsed);
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

        // ─── Team guard: reject webhooks for issues outside our team ───
        const teamKey = process.env.AOS_LINEAR_TEAM_KEY;
        if (teamKey) {
          const issueId = payload.data?.identifier       // Issue events
            || payload.data?.issue?.identifier            // Comment events
            || payload.issue?.identifier                  // AgentSession events
            || '';
          if (issueId && !issueId.startsWith(teamKey + '-')) {
            console.log(chalk.dim(`  [SKIP] ${issueId} belongs to another team (not ${teamKey})`));
            return;
          }
        }

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
  let eventPurgeCycle = 0;
  const EVENT_PURGE_INTERVAL = 40; // every ~10 min (40 × 15s)

  async function monitorLoop(): Promise<void> {
    // Liveness heartbeat first — written even if a later step throws or hangs
    // a previous invocation (setInterval fires regardless). RYA-1180.
    writeServeHeartbeat(port);
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
      await ceoOfficeTriageHeartbeat();
      await ceoOfficeDailyDispatch();
      await validateAndRefreshAllTokens();
      await proactiveChannelHeartbeat();
      await scanProactiveIdeas();
      await weeklyPnLDigestHeartbeat();
  await costAttributionHeartbeat();

      // Periodic events table retention (every ~10 min)
      if (++eventPurgeCycle >= EVENT_PURGE_INTERVAL) {
        eventPurgeCycle = 0;
        const purged = purgeOldEvents();
        if (purged > 0) console.log(chalk.gray(`[GC] Purged ${purged} old events (>7 days)`));
      }
    } catch (err) {
      console.log(chalk.red(`Monitor error: ${(err as Error).message}`));
    }
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(chalk.red(`Port ${port} already in use. Is AgentOS already running?`));
    } else {
      console.error(chalk.red(`Server error: ${err.message}`));
    }
    process.exit(1);
  });

  server.listen(port, async () => {
    markServeStarted(); // Anchor restart cooldown timer (prevents dispatch storm)
    writeServeHeartbeat(port); // Immediate heartbeat so the watchdog sees recovery without waiting a tick
    // Validate all tokens on startup (non-blocking)
    forceTokenCheck().catch(err =>
      console.log(chalk.yellow(`[token-health] Startup check failed: ${(err as Error).message}`)));

    // RYA-1206: replay handoff actions journaled before a mid-completion
    // restart (auto-deploy) — declared dispatches/delegate/parent_status/
    // review_dispatch must not be silently dropped. Non-blocking.
    replayPendingHandoffActions().catch(err =>
      console.log(chalk.yellow(`[action-journal] Replay failed: ${(err as Error).message}`)));

    console.log(chalk.bold(`AgentOS Webhook Server + Monitor v${version}`));
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
    writeServeStopMarker(signal); // Tells the watchdog this is an intentional stop, not a crash
    stopDiscordBot();
    closeDb(); // WAL checkpoint + close
    process.exit(0);
  };
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Periodic DB backup — every 30 minutes
  setInterval(() => { backupDb(); }, 30 * 60_000);

  // Periodic memory sync — every 5 minutes (keeps DB search index fresh)
  try {
    const { syncAllMemories } = await import('../core/memory-store.js');
    setInterval(() => {
      try { syncAllMemories(); } catch { /* best effort */ }
    }, 5 * 60_000);
    // Initial sync on startup
    syncAllMemories();
  } catch { /* memory store may not be available */ }

  setInterval(monitorLoop, POLL_INTERVAL_MS);
}
