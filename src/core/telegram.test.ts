import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  postToGroup,
  sendTelegramMessage,
  parseMentions,
  _resetDedup,
  _getRecentMessages,
} from './telegram.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock config
vi.mock('./config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test-state' }),
}));

// Mock persona — listAgents() reads filesystem which is mocked
vi.mock('./persona.js', () => ({
  listAgents: () => ['cto', 'cpo', 'coo', 'lead-engineer', 'research-lead', 'ceo-office'],
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: (p: string) => p.includes('telegram.json'),
    readFileSync: (p: string) => {
      if (p.includes('telegram.json')) {
        return JSON.stringify({
          groupChatId: '-1001234567890',
          bots: { cto: 'fake-cto-token', 'lead-engineer': 'fake-eng-token' },
        });
      }
      return (actual as any).readFileSync(p);
    },
  };
});

describe('sendTelegramMessage', () => {
  beforeEach(() => {
    _resetDedup();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  it('sends a message to Telegram API', async () => {
    const result = await sendTelegramMessage('fake-token', '-100123', 'Hello');
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botfake-token/sendMessage');
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe('-100123');
    expect(body.text).toBe('Hello');
    expect(body.parse_mode).toBe('Markdown');
  });

  it('returns false on fetch error', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const result = await sendTelegramMessage('fake-token', '-100123', 'test');
    expect(result).toBe(false);
  });

  it('returns false when API returns ok:false', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false }),
    });
    const result = await sendTelegramMessage('fake-token', '-100123', 'test');
    expect(result).toBe(false);
  });
});

describe('postToGroup', () => {
  beforeEach(() => {
    _resetDedup();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  it('posts using role-specific bot token', async () => {
    const result = await postToGroup('cto', 'Hello from CTO');
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('fake-cto-token');
  });

  it('falls back to first bot with role prefix when role has no bot', async () => {
    const result = await postToGroup('coo', 'Hello from COO');
    expect(result).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe('[COO] Hello from COO');
  });
});

describe('content dedup (30s window)', () => {
  beforeEach(() => {
    _resetDedup();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  it('blocks identical messages within 30s', async () => {
    await sendTelegramMessage('tok', '-1', 'same message');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second identical message — should be deduped
    const result = await sendTelegramMessage('tok', '-1', 'same message');
    expect(result).toBe(true); // returns true (silently succeeds)
    expect(mockFetch).toHaveBeenCalledTimes(1); // NOT called again
  });

  it('blocks identical messages even from different tokens', async () => {
    await sendTelegramMessage('tok-a', '-1', 'overlapping content');
    await sendTelegramMessage('tok-b', '-1', 'overlapping content');
    // Only one fetch — dedup is content-based, not token-based
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('allows different messages', async () => {
    await sendTelegramMessage('tok', '-1', 'message A');
    await sendTelegramMessage('tok', '-1', 'message B');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('allows same message after dedup window expires', async () => {
    vi.useFakeTimers();
    try {
      await sendTelegramMessage('tok', '-1', 'repeated message');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past 30s window
      vi.advanceTimersByTime(31_000);

      await sendTelegramMessage('tok', '-1', 'repeated message');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still dedupes within the window', async () => {
    vi.useFakeTimers();
    try {
      await sendTelegramMessage('tok', '-1', 'timed message');
      vi.advanceTimersByTime(15_000); // 15s — still within window
      await sendTelegramMessage('tok', '-1', 'timed message');
      expect(mockFetch).toHaveBeenCalledTimes(1); // deduped
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans old entries when map exceeds 50', async () => {
    vi.useFakeTimers();
    try {
      // Fill 51 unique messages
      for (let i = 0; i < 51; i++) {
        mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
        await sendTelegramMessage('tok', '-1', `msg-${i}`);
      }
      // Advance past dedup window
      vi.advanceTimersByTime(31_000);
      // Post one more to trigger cleanup
      await sendTelegramMessage('tok', '-1', 'trigger-cleanup');
      // Map should have been cleaned (old entries removed)
      expect(_getRecentMessages().size).toBeLessThanOrEqual(51);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('message truncation', () => {
  beforeEach(() => {
    _resetDedup();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  it('does not truncate messages under 4000 chars', async () => {
    const msg = 'a'.repeat(4000);
    await sendTelegramMessage('tok', '-1', msg);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe(msg);
    expect(body.text).not.toContain('truncated');
  });

  it('truncates messages over 4000 chars with suffix', async () => {
    const msg = 'a'.repeat(5000);
    await sendTelegramMessage('tok', '-1', msg);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text.length).toBeLessThan(4096);
    expect(body.text).toContain('...(truncated)');
    expect(body.text.startsWith('a'.repeat(4000))).toBe(true);
  });

  it('truncation + dedup: truncated version is deduped correctly', async () => {
    const longMsg = 'b'.repeat(5000);
    await sendTelegramMessage('tok-a', '-1', longMsg);
    await sendTelegramMessage('tok-b', '-1', longMsg);
    // Second call should be deduped (same truncated content)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('parseMentions', () => {
  it('parses @cto mention', () => {
    expect(parseMentions('Hey @cto check this')).toEqual(['cto']);
  });

  it('parses multiple mentions', () => {
    const mentions = parseMentions('@cto @cpo please review');
    expect(mentions).toContain('cto');
    expect(mentions).toContain('cpo');
  });

  it('normalizes role aliases', () => {
    expect(parseMentions('@eng fix this')).toEqual(['lead-engineer']);
    expect(parseMentions('@lead_engineer check')).toEqual(['lead-engineer']);
  });

  it('parses @ryanhub_ prefixed mentions', () => {
    expect(parseMentions('hey @ryanhub_cto')).toEqual(['cto']);
  });

  it('returns empty for no mentions', () => {
    expect(parseMentions('no mentions here')).toEqual([]);
  });

  it('deduplicates role mentions', () => {
    const mentions = parseMentions('@eng @lead-engineer @lead_engineer');
    expect(mentions).toEqual(['lead-engineer']);
  });
});
