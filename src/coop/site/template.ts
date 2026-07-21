/**
 * Minimal HTML template helpers. No external dependencies.
 *
 * `html` is a tagged template that auto-escapes interpolated values
 * unless they're wrapped with `raw(...)` (for pre-rendered HTML) or `rawArray`.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RAW = Symbol('raw');

export interface RawHtml {
  [RAW]: true;
  value: string;
}

export function raw(value: string): RawHtml {
  return { [RAW]: true, value };
}

export function isRaw(v: unknown): v is RawHtml {
  return typeof v === 'object' && v !== null && (v as RawHtml)[RAW] === true;
}

type Interpolation = string | number | boolean | null | undefined | RawHtml | Interpolation[];

function stringify(v: Interpolation): string {
  if (v === null || v === undefined || v === false) return '';
  if (isRaw(v)) return v.value;
  if (Array.isArray(v)) return v.map(stringify).join('');
  if (typeof v === 'string') return escapeHtml(v);
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): RawHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += stringify(values[i]) + strings[i + 1];
  }
  return raw(out);
}

/**
 * Very small markdown→HTML converter. Enough for our needs:
 * headings, bold, italic, inline code, fenced code, lists, paragraphs, links.
 * Not a full markdown parser — deliberate. The point is predictable output
 * that can be audited for redactor violations.
 */
export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${inline(paraBuf.join(' '))}</p>`);
      paraBuf = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const inline = (s: string): string => {
    let r = escapeHtml(s);
    r = r.replace(/`([^`]+)`/g, '<code>$1</code>');
    r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    r = r.replace(/(^|\W)\*([^*]+)\*/g, '$1<em>$2</em>');
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return r;
  };

  for (const line of lines) {
    if (inCode) {
      if (line.startsWith('```')) {
        out.push(
          `<pre class="code"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ''}><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`,
        );
        codeBuf = [];
        codeLang = '';
        inCode = false;
      } else {
        codeBuf.push(line);
      }
      continue;
    }

    if (line.startsWith('```')) {
      flushPara();
      flushList();
      inCode = true;
      codeLang = line.slice(3).trim();
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want: 'ul' | 'ol' = ul ? 'ul' : 'ol';
      if (listType !== want) {
        flushList();
        listType = want;
        out.push(`<${listType}>`);
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      paraBuf.push(line);
    }
  }
  flushPara();
  flushList();
  if (inCode && codeBuf.length) {
    // Unterminated fenced block — close it anyway.
    out.push(`<pre class="code"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  return out.join('\n');
}
