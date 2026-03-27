import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  postToDiscord,
  parseDiscordMentions,
  _resetDedup,
  _getRecentMessages,
} from './discord.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock config to return a webhook URL
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
    existsSync: (p: string) => p.includes('discord.json'),
    readFileSync: (p: string) => {
      if (p.includes('discord.json')) {
        return JSON.stringify({ webhookUrl: 'https://discord.test/webhook' });
      }
      return (actual as any).readFileSync(p);
    },
  };
});

describe('postToDiscord', () => {
  beforeEach(() => {
    _resetDedup();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true });
  });

  it('posts a message to Discord webhook', async () => {
    const result = await postToDiscord('cto', 'Hello from CTO');
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://discord.test/webhook');
    const body = JSON.parse(opts.body);
    expect(body.username).toBe('CTO');
    expect(body.content).toBe('Hello from CTO');
  });

  it('uses correct display names per role', async () => {
    await postToDiscord('lead-engineer', 'test');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.username).toBe('Lead Engineer');
  });

  describe('content dedup (30s window)', () => {
    it('blocks identical messages within 30s', async () => {
      await postToDiscord('cto', 'same message');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second identical message — should be deduped
      const result = await postToDiscord('cto', 'same message');
      expect(result).toBe(true); // returns true (silently succeeds)
      expect(mockFetch).toHaveBeenCalledTimes(1); // NOT called again
    });

    it('blocks identical messages even from different roles', async () => {
      await postToDiscord('cto', 'overlapping content');
      await postToDiscord('lead-engineer', 'overlapping content');
      // Only one fetch — dedup is content-based, not role-based
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('allows different messages', async () => {
      await postToDiscord('cto', 'message A');
      await postToDiscord('cto', 'message B');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('allows same message after dedup window expires', async () => {
      vi.useFakeTimers();
      try {
        await postToDiscord('cto', 'repeated message');
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Advance past 30s window
        vi.advanceTimersByTime(31_000);

        await postToDiscord('cto', 'repeated message');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still dedupes within the window', async () => {
      vi.useFakeTimers();
      try {
        await postToDiscord('cto', 'timed message');
        vi.advanceTimersByTime(15_000); // 15s — still within window
        await postToDiscord('cto', 'timed message');
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
          mockFetch.mockResolvedValue({ ok: true });
          await postToDiscord('cto', `msg-${i}`);
        }
        // Advance past dedup window
        vi.advanceTimersByTime(31_000);
        // Post one more to trigger cleanup
        await postToDiscord('cto', 'trigger-cleanup');
        // Map should have been cleaned (old entries removed)
        expect(_getRecentMessages().size).toBeLessThanOrEqual(51);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('message truncation', () => {
    it('does not truncate messages under 1950 chars', async () => {
      const msg = 'a'.repeat(1950);
      await postToDiscord('cto', msg);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content).toBe(msg);
      expect(body.content).not.toContain('truncated');
    });

    it('truncates messages over 1950 chars with suffix', async () => {
      const msg = 'a'.repeat(2500);
      await postToDiscord('cto', msg);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content.length).toBeLessThan(2000);
      expect(body.content).toContain('...(truncated)');
      expect(body.content.startsWith('a'.repeat(1950))).toBe(true);
    });

    it('truncation + dedup: truncated version is deduped correctly', async () => {
      const longMsg = 'b'.repeat(2500);
      await postToDiscord('cto', longMsg);
      await postToDiscord('lead-engineer', longMsg);
      // Second call should be deduped (same truncated content)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe('parseDiscordMentions', () => {
  it('parses @cto mention', () => {
    expect(parseDiscordMentions('Hey @cto check this')).toEqual(['cto']);
  });

  it('parses multiple mentions', () => {
    const mentions = parseDiscordMentions('@cto @cpo please review');
    expect(mentions).toContain('cto');
    expect(mentions).toContain('cpo');
  });

  it('normalizes role aliases', () => {
    expect(parseDiscordMentions('@eng fix this')).toEqual(['lead-engineer']);
    expect(parseDiscordMentions('@lead engineer check')).toEqual(['lead-engineer']);
  });

  it('returns empty for no mentions', () => {
    expect(parseDiscordMentions('no mentions here')).toEqual([]);
  });

  it('deduplicates role mentions', () => {
    const mentions = parseDiscordMentions('@eng @lead-engineer @engineer');
    expect(mentions).toEqual(['lead-engineer']);
  });
});
