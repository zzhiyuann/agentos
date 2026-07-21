import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/config.js', () => ({
  getConfig: vi.fn(() => ({ stateDir: '/tmp/aos-test-state' })),
}));

vi.mock('../core/tmux.js', () => ({
  createTmuxSession: vi.fn(),
  sessionExists: vi.fn(() => false),
  killSession: vi.fn(),
  sendKeys: vi.fn(),
  listSessionsByPrefix: vi.fn(() => []),
}));

import {
  chatSessionName, pipeToChatSession, reapIdleChatSessions,
  chatLastActivity, CHAT_IDLE_TTL_MS,
} from './chat-session.js';
import { createTmuxSession, sessionExists, killSession, sendKeys, listSessionsByPrefix } from '../core/tmux.js';

describe('chat-session (B: Discord chat tier)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatLastActivity.clear();
  });

  it('names sessions aos-{role}-chat', () => {
    expect(chatSessionName('cto')).toBe('aos-cto-chat');
  });

  it('spawns a new session with the first message as the CLI prompt', () => {
    vi.mocked(sessionExists).mockReturnValue(false);
    pipeToChatSession('cto', 'hello there');
    expect(createTmuxSession).toHaveBeenCalledWith(
      'aos-cto-chat',
      expect.stringContaining('cto-chat'),
      expect.stringContaining('hello there'),
    );
    expect(sendKeys).not.toHaveBeenCalled();
    expect(chatLastActivity.get('cto')).toBeGreaterThan(0);
  });

  it('pipes into an existing session via sendKeys', () => {
    vi.mocked(sessionExists).mockReturnValue(true);
    pipeToChatSession('cto', 'follow-up question');
    expect(sendKeys).toHaveBeenCalledWith('aos-cto-chat', 'follow-up question');
    expect(createTmuxSession).not.toHaveBeenCalled();
  });

  it('escapes single quotes in the spawn prompt', () => {
    vi.mocked(sessionExists).mockReturnValue(false);
    pipeToChatSession('cto', "what's up");
    const cmd = vi.mocked(createTmuxSession).mock.calls[0][2];
    expect(cmd).toContain("what'\\''s up");
  });

  it('reaps sessions idle past the TTL', () => {
    vi.mocked(listSessionsByPrefix).mockReturnValue(['aos-cto-chat', 'aos-coo-RYA-1']);
    chatLastActivity.set('cto', Date.now() - CHAT_IDLE_TTL_MS - 1000);
    reapIdleChatSessions();
    expect(killSession).toHaveBeenCalledWith('aos-cto-chat');
    expect(chatLastActivity.has('cto')).toBe(false);
  });

  it('does not reap active sessions or non-chat sessions', () => {
    vi.mocked(listSessionsByPrefix).mockReturnValue(['aos-cto-chat']);
    chatLastActivity.set('cto', Date.now() - 60_000);
    reapIdleChatSessions();
    expect(killSession).not.toHaveBeenCalled();
  });

  it('grants discovered sessions a fresh TTL window after restart', () => {
    vi.mocked(listSessionsByPrefix).mockReturnValue(['aos-cpo-chat']);
    reapIdleChatSessions();
    expect(killSession).not.toHaveBeenCalled();
    expect(chatLastActivity.get('cpo')).toBeGreaterThan(0);
  });
});
