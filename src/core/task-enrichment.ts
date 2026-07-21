import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig } from './config.js';
import { getCachedEnrichment as getCachedEnrichmentRaw, cacheEnrichment as cacheEnrichmentRaw } from './db.js';

/** Structured task spec produced by enrichment */
export interface TaskSpec {
  deliverable: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  definitionOfDone: string;
}

// Trivial task patterns — skip enrichment for these
const TRIVIAL_PATTERNS = /\b(fix|hotfix|bug\s*fix|typo|lint|cleanup|clean-?up|rename|bump|patch|chore|refactor|nit)\b/i;

/**
 * Check if a task title indicates a trivial task that doesn't need enrichment.
 */
export function isTrivialTask(title: string): boolean {
  return TRIVIAL_PATTERNS.test(title);
}

/**
 * Format a TaskSpec into a markdown section to append to the task prompt.
 */
export function formatTaskSpec(spec: TaskSpec): string {
  const lines = [
    '',
    '## Structured Task Spec (auto-generated)',
    '',
    '### Deliverable',
    spec.deliverable,
    '',
    '### Acceptance Criteria',
    ...spec.acceptanceCriteria.map(c => `- [ ] ${c}`),
    '',
    '### Dependencies',
    spec.dependencies.length > 0
      ? spec.dependencies.map(d => `- ${d}`).join('\n')
      : '- None identified',
    '',
    '### Definition of Done',
    spec.definitionOfDone,
    '',
  ];
  return lines.join('\n');
}

/**
 * Get the Anthropic API key from the state directory or environment.
 */
function getAnthropicKey(): string | null {
  const keyFile = join(getConfig().stateDir, '.anthropic-key');
  if (existsSync(keyFile)) {
    return readFileSync(keyFile, 'utf-8').trim();
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

/**
 * Call Haiku to generate a structured task spec from a raw issue title + description.
 */
async function callHaikuForEnrichment(title: string, description?: string): Promise<TaskSpec> {
  const apiKey = getAnthropicKey();
  if (!apiKey) {
    throw new Error('No Anthropic API key found — cannot enrich task');
  }

  const prompt = `You are a technical project manager. Given a task title and description, produce a structured specification.

Task title: ${title}
${description ? `Task description:\n${description}` : 'No description provided.'}

Respond with ONLY valid JSON (no markdown fences, no explanation) in this exact format:
{
  "deliverable": "What must be produced (1-2 sentences)",
  "acceptanceCriteria": ["Criterion 1", "Criterion 2", "..."],
  "dependencies": ["What this feeds into or depends on"],
  "definitionOfDone": "Exact conditions that mean this task is complete"
}

Rules:
- acceptanceCriteria should have 3-6 concrete, testable items
- dependencies should list upstream/downstream relationships if evident from the description, otherwise empty array
- definitionOfDone should be a single clear statement combining the key criteria
- Be specific and actionable, not vague`;

  // 10-second timeout to prevent stalling the agent spawn flow
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Haiku API error ${response.status}: ${body}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content?.[0]?.text;
  if (!text) {
    throw new Error('Empty response from Haiku');
  }

  // Parse JSON — strip any markdown fences if the model wraps them
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const parsed = JSON.parse(cleaned) as TaskSpec;

  // Validate structure
  if (!parsed.deliverable || !Array.isArray(parsed.acceptanceCriteria) || !parsed.definitionOfDone) {
    throw new Error('Invalid task spec structure from Haiku');
  }

  return {
    deliverable: String(parsed.deliverable),
    acceptanceCriteria: parsed.acceptanceCriteria.map(String),
    dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.map(String) : [],
    definitionOfDone: String(parsed.definitionOfDone),
  };
}

/**
 * Enrich a task with structured acceptance criteria.
 * Returns null for trivial tasks or on failure (non-blocking).
 * Caches results per issue key.
 */
export async function enrichTask(
  issueKey: string,
  title: string,
  description?: string,
): Promise<TaskSpec | null> {
  // Skip trivial tasks
  if (isTrivialTask(title)) {
    return null;
  }

  // Check cache first
  const cached = getCachedEnrichmentRaw(issueKey) as TaskSpec | null;
  if (cached && cached.deliverable && Array.isArray(cached.acceptanceCriteria)) {
    return cached;
  }

  // Call Haiku for enrichment
  try {
    const spec = await callHaikuForEnrichment(title, description);
    cacheEnrichmentRaw(issueKey, spec as unknown as Record<string, unknown>);
    return spec;
  } catch (err) {
    // Non-blocking — log and continue without enrichment
    console.warn(`[task-enrichment] Failed to enrich ${issueKey}: ${(err as Error).message}`);
    return null;
  }
}
