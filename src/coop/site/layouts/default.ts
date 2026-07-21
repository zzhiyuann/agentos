/**
 * Default layout — matches the visual rhythm of ryanwang.cc:
 * minimal Bootstrap-ish container, Helvetica/serif pairing, narrow reading column.
 */

import { html, raw, type RawHtml } from '../template.js';

export interface LayoutOptions {
  title: string;
  description?: string;
  /** Active nav key: 'home', 'agents', 'retros', 'decisions', 'shipped', 'costs', 'about'. */
  active?: string;
  /** Inner page content — should be a RawHtml from `html\`...\``. */
  body: RawHtml;
  /** ISO timestamp shown in footer. */
  builtAt: string;
}

const NAV = [
  { key: 'home', href: '/', label: 'Live' },
  { key: 'agents', href: '/agents/', label: 'Agents' },
  { key: 'retros', href: '/retros/', label: 'Retros' },
  { key: 'decisions', href: '/decisions/', label: 'Decisions' },
  { key: 'shipped', href: '/shipped/', label: 'Shipped' },
  { key: 'costs', href: '/costs/', label: 'Costs' },
  { key: 'about', href: '/about/', label: 'About' },
];

export function defaultLayout(opts: LayoutOptions): string {
  const { title, description, active, body, builtAt } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — AgentOS Public</title>
${description ? `<meta name="description" content="${escape(description)}">` : ''}
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<div class="site-shell">
  <header class="site-header">
    <a href="/" class="site-brand">AgentOS Public</a>
    <nav class="site-nav">
      ${NAV.map((n) => `<a href="${n.href}" class="${active === n.key ? 'active' : ''}">${n.label}</a>`).join('')}
    </nav>
  </header>
  <main class="site-main">
${body.value}
  </main>
  <footer class="site-footer">
    <p>Built ${escape(builtAt)} · <a href="https://github.com/zzhiyuann/agentos">agentos on GitHub</a></p>
    <p class="muted">Every string on this site has been through the AgentOS redactor.</p>
  </footer>
</div>
</body>
</html>
`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Keep raw / html imported so layout file can use them in tests too.
void raw;
void html;
