/**
 * Page renderers — one function per route. Each returns `{ path, html }`
 * where `path` is relative to the site root (e.g. '/index.html').
 *
 * Every string that lands in HTML here has already been through the
 * redactor (inside the collectors). We do NOT redact again — the audit
 * happens at the bundle layer.
 */

import { html, raw, renderMarkdown } from './template.js';
import { defaultLayout } from './layouts/default.js';
import type { CoopBundle, AgentRole } from '../types.js';

export interface RenderedPage {
  path: string; // e.g. '/index.html', '/agents/cto/index.html'
  html: string;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

// ------- Home / live dashboard -------
function renderHome(bundle: CoopBundle): RenderedPage {
  const liveCount = bundle.linear.items.filter((i) => i.status === 'In Progress' || i.status === 'In Review').length;
  const shippedCount = bundle.git.items.length;
  const latestRetro = bundle.retros.items[0];

  const body = html`
    <h1>Live.</h1>
    <p class="meta">One-person AI company, running in public. Built ${fmtDate(bundle.builtAt)}.</p>

    <h2>Right now</h2>
    <ul>
      <li><strong>${liveCount}</strong> issues moving through the pipeline</li>
      <li><strong>${shippedCount}</strong> commits shipped in the last day</li>
      <li>Agents on duty: ${raw(
        [...new Set(bundle.cost.items.map((c) => c.role))]
          .map((r) => `<a href="/agents/${encodeURIComponent(r)}/">${r}</a>`)
          .join(', '),
      )}</li>
    </ul>

    <h2>Latest retro</h2>
    ${latestRetro ? raw(renderMarkdown(latestRetro.body)) : html`<p class="muted">No retros yet.</p>`}

    <h2>In-flight issues</h2>
    <ul class="card-list">
      ${bundle.linear.items.slice(0, 10).map((i) => html`
        <li>
          <p class="card-title">${i.key} · ${i.title}</p>
          <p class="card-meta">
            ${i.status}
            ${i.assignee ? ` · ${i.assignee}` : ''}
            · updated ${fmtDate(i.updatedAt)}
            ${raw(i.labels.map((l) => `<span class="label">${l}</span>`).join(' '))}
          </p>
        </li>
      `)}
    </ul>
  `;

  return {
    path: '/index.html',
    html: defaultLayout({ title: 'Live', active: 'home', body, builtAt: bundle.builtAt }),
  };
}

// ------- Agents index + per-agent pages -------
function renderAgentsIndex(bundle: CoopBundle): RenderedPage {
  const roles = new Set<AgentRole>();
  bundle.retros.items.forEach((r) => roles.add(r.role));
  bundle.cost.items.forEach((c) => roles.add(c.role));

  const rows = [...roles].sort().map((role) => {
    const retroCount = bundle.retros.items.filter((r) => r.role === role).length;
    const cost = bundle.cost.items.find((c) => c.role === role);
    return html`
      <li>
        <p class="card-title"><a href="/agents/${encodeURIComponent(role)}/">${role}</a></p>
        <p class="card-meta">
          ${retroCount} retro${retroCount === 1 ? '' : 's'} published${cost ? ` · budget $${cost.usd.toFixed(2)}/day` : ''}
        </p>
      </li>
    `;
  });

  const body = html`
    <h1>Agents.</h1>
    <p class="meta">Each agent is a persistent identity with its own memory and retrospectives.</p>
    <ul class="card-list">${rows}</ul>
  `;
  return {
    path: '/agents/index.html',
    html: defaultLayout({ title: 'Agents', active: 'agents', body, builtAt: bundle.builtAt }),
  };
}

function renderAgentPages(bundle: CoopBundle): RenderedPage[] {
  const roles = new Set<AgentRole>();
  bundle.retros.items.forEach((r) => roles.add(r.role));
  bundle.cost.items.forEach((c) => roles.add(c.role));

  return [...roles].map((role) => {
    const retros = bundle.retros.items.filter((r) => r.role === role);
    const cost = bundle.cost.items.find((c) => c.role === role);

    const body = html`
      <h1>${role}</h1>
      ${cost ? html`<p class="meta">Weekly budget: $${cost.usd.toFixed(2)} · ${cost.week}</p>` : ''}

      <h2>Retrospectives</h2>
      ${retros.length === 0
        ? html`<p class="muted">No retros published yet.</p>`
        : retros.map((r) => html`
            <h3>${fmtDate(r.date)}</h3>
            ${raw(renderMarkdown(r.body))}
          `)}
    `;
    return {
      path: `/agents/${role}/index.html`,
      html: defaultLayout({ title: role, active: 'agents', body, builtAt: bundle.builtAt }),
    };
  });
}

// ------- Retros aggregate -------
function renderRetros(bundle: CoopBundle): RenderedPage {
  const body = html`
    <h1>Retros.</h1>
    <p class="meta">Daily retrospectives, redacted and published.</p>
    ${bundle.retros.items.length === 0
      ? html`<p class="muted">No retros in the last 30 days.</p>`
      : bundle.retros.items.map((r) => html`
          <h2>${r.role} · ${fmtDate(r.date)}</h2>
          ${raw(renderMarkdown(r.body))}
        `)}
  `;
  return {
    path: '/retros/index.html',
    html: defaultLayout({ title: 'Retros', active: 'retros', body, builtAt: bundle.builtAt }),
  };
}

// ------- Decisions (from public shared-memory) -------
function renderDecisions(bundle: CoopBundle): RenderedPage {
  const body = html`
    <h1>Decisions.</h1>
    <p class="meta">Public shared-memory entries — the reasoning behind the company's direction.</p>
    ${bundle.memory.items.length === 0
      ? html`<p class="muted">No public decisions yet. Add <code>public: true</code> front-matter to a shared-memory file to publish it.</p>`
      : bundle.memory.items.map((m) => html`
          <h2>${m.title}</h2>
          ${raw(renderMarkdown(m.body))}
        `)}
  `;
  return {
    path: '/decisions/index.html',
    html: defaultLayout({ title: 'Decisions', active: 'decisions', body, builtAt: bundle.builtAt }),
  };
}

// ------- Shipped (git log) -------
function renderShipped(bundle: CoopBundle): RenderedPage {
  const body = html`
    <h1>Shipped.</h1>
    <p class="meta">Commits landed in the last 24 hours.</p>
    ${bundle.git.items.length === 0
      ? html`<p class="muted">Nothing shipped yet.</p>`
      : html`<ul class="card-list">${bundle.git.items.map((c) => html`
          <li>
            <p class="card-title">${c.subject}</p>
            <p class="card-meta">${c.sha} · ${c.author} · ${fmtDate(c.date)}</p>
            ${c.body.trim() ? raw(`<div class="commit-body">${renderMarkdown(c.body)}</div>`) : ''}
          </li>
        `)}</ul>`}
  `;
  return {
    path: '/shipped/index.html',
    html: defaultLayout({ title: 'Shipped', active: 'shipped', body, builtAt: bundle.builtAt }),
  };
}

// ------- Costs table -------
function renderCosts(bundle: CoopBundle): RenderedPage {
  const rows = bundle.cost.items.map((c) => html`
    <tr>
      <td>${c.role}</td>
      <td>${c.week}</td>
      <td>$${c.usd.toFixed(2)}</td>
      <td>${c.tokens.toLocaleString()}</td>
    </tr>
  `);
  const body = html`
    <h1>Costs.</h1>
    <p class="meta">Per-agent budget and usage. Weekly aggregate.</p>
    ${bundle.cost.items.length === 0
      ? html`<p class="muted">No cost data yet.</p>`
      : html`<table class="costs">
          <thead><tr><th>Agent</th><th>Week</th><th>USD</th><th>Tokens</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
  `;
  return {
    path: '/costs/index.html',
    html: defaultLayout({ title: 'Costs', active: 'costs', body, builtAt: bundle.builtAt }),
  };
}

// ------- About -------
function renderAbout(bundle: CoopBundle): RenderedPage {
  const body = html`
    <h1>About.</h1>
    <p>
      This is <strong>AgentOS Public</strong> — a live window into a one-person AI company.
      Every string on this site has been through a redactor; the full source is
      <a href="https://github.com/zzhiyuann/agentos">on GitHub</a>.
    </p>
    <h2>What's here</h2>
    <ul>
      <li><a href="/">Live</a> — current pipeline state</li>
      <li><a href="/agents/">Agents</a> — per-agent profiles and retrospectives</li>
      <li><a href="/retros/">Retros</a> — every public retrospective</li>
      <li><a href="/decisions/">Decisions</a> — public shared-memory entries</li>
      <li><a href="/shipped/">Shipped</a> — yesterday's commits</li>
      <li><a href="/costs/">Costs</a> — weekly per-agent spend</li>
    </ul>
    <h2>How it works</h2>
    <p>
      A nightly pipeline (<code>aos coop build</code>) reads from Linear, the
      agent retrospective files, the shared-memory whitelist, the local git
      log, and the budget config. Every string gets run through a redactor
      that scrubs paths, tokens, emails, and internal hostnames. The result
      is rendered to static HTML and deployed.
    </p>
    <p class="meta">Built ${fmtDate(bundle.builtAt)}.</p>
  `;
  return {
    path: '/about/index.html',
    html: defaultLayout({ title: 'About', active: 'about', body, builtAt: bundle.builtAt }),
  };
}

export function renderSite(bundle: CoopBundle): RenderedPage[] {
  return [
    renderHome(bundle),
    renderAgentsIndex(bundle),
    ...renderAgentPages(bundle),
    renderRetros(bundle),
    renderDecisions(bundle),
    renderShipped(bundle),
    renderCosts(bundle),
    renderAbout(bundle),
  ];
}
