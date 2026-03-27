import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getConfig } from './config.js';

const MAILBOX_DIR = join(getConfig().stateDir, 'mailbox');

export interface Message {
  id: string;
  from: string;
  to: string;
  issueKey?: string;
  type: 'ask' | 'notify';
  content: string;
  timestamp: string;
}

function ensureMailbox(role: string): void {
  const inbox = join(MAILBOX_DIR, role, 'inbox');
  const outbox = join(MAILBOX_DIR, role, 'outbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
}

export function sendMessage(msg: Message): string {
  ensureMailbox(msg.to);
  const filename = `${msg.id}.json`;
  const inboxPath = join(MAILBOX_DIR, msg.to, 'inbox', filename);
  writeFileSync(inboxPath, JSON.stringify(msg, null, 2));
  return msg.id;
}

export function getInboxMessages(role: string): Message[] {
  const inbox = join(MAILBOX_DIR, role, 'inbox');
  if (!existsSync(inbox)) return [];
  return readdirSync(inbox)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(inbox, f), 'utf-8')))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function getResponse(role: string, messageId: string): string | null {
  const outboxPath = join(MAILBOX_DIR, role, 'outbox', `${messageId}.json`);
  if (!existsSync(outboxPath)) return null;
  try {
    const data = JSON.parse(readFileSync(outboxPath, 'utf-8'));
    return data.response || data.content || null;
  } catch {
    return null;
  }
}

export function writeResponse(role: string, messageId: string, response: string): void {
  ensureMailbox(role);
  const outboxPath = join(MAILBOX_DIR, role, 'outbox', `${messageId}.json`);
  writeFileSync(outboxPath, JSON.stringify({ messageId, response, timestamp: new Date().toISOString() }, null, 2));
}

export function clearMessage(role: string, messageId: string): void {
  const inboxPath = join(MAILBOX_DIR, role, 'inbox', `${messageId}.json`);
  try { unlinkSync(inboxPath); } catch { /**/ }
}

/** Poll for a response with timeout */
export async function pollResponse(role: string, messageId: string, timeoutMs = 120_000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = getResponse(role, messageId);
    if (response) {
      clearMessage(role, messageId);
      return response;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}
