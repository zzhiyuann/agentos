import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getConfig } from './config.js';

export interface MemoryValidationResult {
  role: string;
  warnings: string[];
  unindexedFiles: string[];
  staleReferences: string[];
  memoryFileCount: number;
  indexedReferenceCount: number;
}

/**
 * Validate post-session memory state for an agent role.
 *
 * Checks:
 * 1. Memory files in memory/ not referenced in MEMORY.md (unindexed)
 * 2. MEMORY.md references files that don't exist (stale index)
 * 3. Session completed significant work but agent has zero memory files
 *
 * @param role - agent role (e.g. 'cto', 'lead-engineer')
 * @param sessionCompletedWork - whether the session produced a HANDOFF.md (caller determines this)
 * @returns validation result with warnings (empty warnings = all clear)
 */
export function validatePostSessionMemory(
  role: string,
  sessionCompletedWork: boolean = false,
): MemoryValidationResult {
  const config = getConfig();
  const agentDir = join(config.stateDir, 'agents', role);
  const memoryDir = join(agentDir, 'memory');
  const memoryIndexPath = join(agentDir, 'MEMORY.md');

  const result: MemoryValidationResult = {
    role,
    warnings: [],
    unindexedFiles: [],
    staleReferences: [],
    memoryFileCount: 0,
    indexedReferenceCount: 0,
  };

  // Collect actual memory files on disk
  const memoryFiles: string[] = [];
  if (existsSync(memoryDir)) {
    for (const file of readdirSync(memoryDir)) {
      if (file.endsWith('.md')) {
        memoryFiles.push(file);
      }
    }
  }
  result.memoryFileCount = memoryFiles.length;

  // Parse MEMORY.md for referenced files
  const memoryIndexContent = existsSync(memoryIndexPath)
    ? readFileSync(memoryIndexPath, 'utf-8')
    : '';

  const indexedRefs = parseMemoryIndex(memoryIndexContent);
  result.indexedReferenceCount = indexedRefs.length;

  // Check 1: Memory files not referenced in MEMORY.md
  for (const file of memoryFiles) {
    const baseName = file.replace(/\.md$/, '');
    const isReferenced = indexedRefs.some(
      (ref) => ref.includes(file) || ref.includes(baseName),
    );
    if (!isReferenced) {
      result.unindexedFiles.push(file);
    }
  }
  if (result.unindexedFiles.length > 0) {
    result.warnings.push(
      `${result.unindexedFiles.length} memory file(s) not indexed in MEMORY.md: ${result.unindexedFiles.join(', ')}`,
    );
  }

  // Check 2: MEMORY.md references files that don't exist (stale)
  for (const ref of indexedRefs) {
    // Extract just the filename from paths like "memory/foo.md" or "./memory/foo.md"
    const fileName = ref.split('/').pop() || ref;
    const withMd = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
    if (!memoryFiles.includes(withMd)) {
      result.staleReferences.push(ref);
    }
  }
  if (result.staleReferences.length > 0) {
    result.warnings.push(
      `MEMORY.md has ${result.staleReferences.length} stale reference(s) to missing files: ${result.staleReferences.join(', ')}`,
    );
  }

  // Check 3: Session completed work but agent has zero memories
  if (sessionCompletedWork && memoryFiles.length === 0) {
    result.warnings.push(
      'Session completed with HANDOFF.md but agent has zero memory files — memory persistence protocol was not followed.',
    );
  }

  return result;
}

/**
 * Parse MEMORY.md content to extract referenced file paths.
 *
 * Recognizes:
 * - Markdown links: [description](memory/file.md) or [desc](file.md)
 * - Inline code refs: `memory/file.md` or `file.md`
 * - Bare references on a line: - memory/file.md or - file.md
 */
export function parseMemoryIndex(content: string): string[] {
  if (!content.trim()) return [];

  const refs = new Set<string>();

  // Markdown links: [text](path.md)
  const linkRegex = /\[([^\]]*)\]\(([^)]*\.md)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(content)) !== null) {
    refs.add(match[2]);
  }

  // Inline code: `path.md` or `memory/path.md`
  const codeRegex = /`((?:[\w./-]+\/)?[\w-]+\.md)`/g;
  while ((match = codeRegex.exec(content)) !== null) {
    if (!refs.has(match[1])) refs.add(match[1]);
  }

  // Bare file references: lines like "- memory/foo.md" or "- foo.md — description"
  const bareRegex = /(?:^|\n)\s*[-*]\s+((?:memory\/)?[\w-]+\.md)/g;
  while ((match = bareRegex.exec(content)) !== null) {
    if (!refs.has(match[1])) refs.add(match[1]);
  }

  return [...refs];
}

/**
 * Format validation result as a human-readable warning string.
 * Returns empty string if no warnings.
 */
export function formatMemoryWarnings(result: MemoryValidationResult): string {
  if (result.warnings.length === 0) return '';

  const lines = [
    `**Memory validation warnings** for agent \`${result.role}\`:`,
    '',
    ...result.warnings.map((w) => `- ${w}`),
    '',
    `Stats: ${result.memoryFileCount} memory file(s) on disk, ${result.indexedReferenceCount} reference(s) in MEMORY.md`,
  ];

  return lines.join('\n');
}
