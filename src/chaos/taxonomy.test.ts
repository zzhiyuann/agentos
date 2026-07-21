import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import { parseTaxonomy, parseSimpleYaml, loadTaxonomy, findFailureMode } from './taxonomy.js';

describe('chaos taxonomy parser', () => {
  it('parses inline objects in a list', () => {
    const yaml = `
symptoms:
  - { channel: logs, pattern: "Error", required: true }
  - { channel: linear-status, pattern: failed, required: false }
`;
    const out = parseSimpleYaml(yaml);
    expect(Array.isArray(out.symptoms)).toBe(true);
    const arr = out.symptoms as Record<string, unknown>[];
    expect(arr.length).toBe(2);
    expect(arr[0].channel).toBe('logs');
    expect(arr[0].pattern).toBe('Error');
    expect(arr[0].required).toBe(true);
    expect(arr[1].required).toBe(false);
  });

  it('parses scalar string values with and without quotes', () => {
    const out = parseSimpleYaml(`
title: "Quoted title"
description: bare string with spaces
severity: critical
`);
    expect(out.title).toBe('Quoted title');
    expect(out.description).toBe('bare string with spaces');
    expect(out.severity).toBe('critical');
  });

  it('reads booleans and numbers correctly', () => {
    const out = parseSimpleYaml(`
required: true
count: 17
ratio: -0.5
`);
    expect(out.required).toBe(true);
    expect(out.count).toBe(17);
    expect(out.ratio).toBe(-0.5);
  });

  it('parses multiple failure-mode sections from full markdown', () => {
    const md = `
# Header

## failure-mode: foo

\`\`\`yaml
title: Foo title
description: foo desc
surface: dispatch
severity: critical
expectedRecovery: recovers
symptoms:
  - { channel: logs, pattern: foo, required: true }
\`\`\`

## failure-mode: bar

\`\`\`yaml
title: Bar title
description: bar desc
surface: memory
severity: important
expectedRecovery: bar recovers
incidentRefs: ["RYA-1", "RYA-2"]
symptoms:
  - { channel: linear-comments, pattern: bar, required: false }
\`\`\`
`;
    const modes = parseTaxonomy(md);
    expect(modes.length).toBe(2);
    expect(modes[0].id).toBe('foo');
    expect(modes[0].surface).toBe('dispatch');
    expect(modes[0].severity).toBe('critical');
    expect(modes[1].id).toBe('bar');
    expect(modes[1].incidentRefs).toEqual(['RYA-1', 'RYA-2']);
    expect(modes[1].symptoms[0].required).toBe(false);
  });

  it('rejects invalid surface or severity', () => {
    const bad = `
## failure-mode: bad

\`\`\`yaml
title: T
description: D
surface: not-a-surface
severity: critical
expectedRecovery: R
symptoms:
  - { channel: logs, pattern: x, required: true }
\`\`\`
`;
    expect(() => parseTaxonomy(bad)).toThrow(/invalid surface/);
  });

  it('rejects missing required string fields', () => {
    const bad = `
## failure-mode: bad

\`\`\`yaml
title: T
surface: dispatch
severity: critical
expectedRecovery: R
symptoms:
  - { channel: logs, pattern: x, required: true }
\`\`\`
`;
    expect(() => parseTaxonomy(bad)).toThrow(/description/);
  });

  it('throws if no failure modes present', () => {
    expect(() => parseTaxonomy('# nothing here\n')).toThrow(/No failure modes/);
  });

  it('loadTaxonomy reads the seed taxonomy successfully', () => {
    const modes = loadTaxonomy();
    expect(modes.length).toBeGreaterThanOrEqual(5);
    const ids = modes.map(m => m.id);
    expect(ids).toContain('rate-limit-cascade');
    expect(ids).toContain('silent-failure-swallow');
  });

  it('findFailureMode throws on unknown id with helpful list', () => {
    const modes = loadTaxonomy();
    expect(() => findFailureMode(modes, 'nonexistent')).toThrow(/Available:/);
  });

  it('honors AOS_CHAOS_TAXONOMY env var override', () => {
    const tmp = path.join(os.tmpdir(), `chaos-tax-${Date.now()}.md`);
    writeFileSync(tmp, `
## failure-mode: env-override

\`\`\`yaml
title: Env override
description: only one mode here
surface: other
severity: informational
expectedRecovery: nothing
symptoms:
  - { channel: logs, pattern: foo, required: true }
\`\`\`
`);
    try {
      const modes = loadTaxonomy(tmp);
      expect(modes.length).toBe(1);
      expect(modes[0].id).toBe('env-override');
    } finally {
      unlinkSync(tmp);
    }
  });
});
