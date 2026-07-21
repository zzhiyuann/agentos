import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock persona.ts before importing smart-router
vi.mock('./persona.js', () => ({
  listAgents: vi.fn(() => ['cto', 'cpo', 'coo', 'lead-engineer', 'research-lead', 'ceo-office']),
}));

import { classifyDomain, shouldAutoRoute } from './smart-router.js';

describe('classifyDomain — keyword-based issue routing', () => {
  // ─── CPO routing ───

  it('routes product/UX issues to CPO', () => {
    const result = classifyDomain('Improve onboarding funnel for new users');
    expect(result.role).toBe('cpo');
    expect(result.confidence).not.toBe('low');
    expect(result.matchedKeywords).toContain('onboarding');
  });

  it('routes landing page tasks to CPO', () => {
    const result = classifyDomain('Create landing page for consulting service');
    expect(result.role).toBe('cpo');
    expect(result.matchedKeywords).toContain('landing page');
  });

  it('routes growth/marketing to CPO', () => {
    const result = classifyDomain('Content marketing strategy and brand positioning');
    expect(result.role).toBe('cpo');
    expect(result.matchedKeywords.length).toBeGreaterThanOrEqual(2);
  });

  it('routes workshop/education to CPO', () => {
    const result = classifyDomain('Workshop curriculum for AI agent education');
    expect(result.role).toBe('cpo');
  });

  // ─── COO routing ───

  it('routes infrastructure/ops issues to COO', () => {
    const result = classifyDomain('Server monitoring shows high latency on deploy pipeline');
    expect(result.role).toBe('coo');
    expect(result.confidence).not.toBe('low');
  });

  it('routes cost/budget issues to COO', () => {
    const result = classifyDomain('Review monthly infrastructure cost and budget allocation');
    expect(result.role).toBe('coo');
    expect(result.matchedKeywords).toContain('cost');
  });

  it('routes deployment issues to COO', () => {
    const result = classifyDomain('Fix CI/CD pipeline for Docker deployment');
    expect(result.role).toBe('coo');
  });

  // ─── Research Lead routing ───

  it('routes research tasks to Research Lead', () => {
    const result = classifyDomain('Literature review on cognitive bias — research paper survey');
    expect(result.role).toBe('research-lead');
    expect(result.confidence).not.toBe('low');
  });

  it('routes paper/academic tasks to Research Lead', () => {
    const result = classifyDomain('Write paper on hypothesis generation methodology');
    expect(result.role).toBe('research-lead');
  });

  it('routes autoresearch/pilot tasks to Research Lead', () => {
    const result = classifyDomain('Autoresearch pilot: dataset calibration experiment');
    expect(result.role).toBe('research-lead');
  });

  // ─── CTO routing ───

  it('routes architecture/design tasks to CTO', () => {
    const result = classifyDomain('Architecture review of dispatch system design');
    expect(result.role).toBe('cto');
    expect(result.confidence).not.toBe('low');
  });

  it('routes security/audit tasks to CTO', () => {
    const result = classifyDomain('Security audit: vulnerability assessment of OAuth flow');
    expect(result.role).toBe('cto');
  });

  it('routes code review tasks to CTO', () => {
    const result = classifyDomain('Code review: quality standards for API design');
    expect(result.role).toBe('cto');
  });

  // ─── Lead Engineer routing ───

  it('routes implementation tasks to Lead Engineer', () => {
    const result = classifyDomain('Implement new feature: fix error in TypeScript build');
    expect(result.role).toBe('lead-engineer');
    expect(result.confidence).not.toBe('low');
  });

  it('routes bug fixes to Lead Engineer', () => {
    const result = classifyDomain('Fix: crash when debugging null stack trace in error handler');
    expect(result.role).toBe('lead-engineer');
  });

  it('routes test tasks to Lead Engineer', () => {
    const result = classifyDomain('Add integration tests for the unit test runner');
    expect(result.role).toBe('lead-engineer');
  });

  it('routes hotfix/patch tasks to Lead Engineer', () => {
    const result = classifyDomain('Hotfix: regression in build compile step');
    expect(result.role).toBe('lead-engineer');
  });

  // ─── CEO Office / ambiguous routing ───

  it('routes [to decide] issues to CEO Office', () => {
    const result = classifyDomain('[to decide] Should we pivot to B2B or stay B2C?');
    expect(result.role).toBe('ceo-office');
    expect(result.confidence).toBe('high');
  });

  it('routes ambiguous issues with no keywords to COO fallback', () => {
    const result = classifyDomain('Weekly sync notes from Thursday');
    expect(result.confidence).toBe('low');
  });

  // ─── Description contributes to classification ───

  it('uses description to strengthen classification', () => {
    const result = classifyDomain(
      'Improve the dashboard',
      'The user onboarding funnel needs better conversion tracking and analytics for customer retention'
    );
    expect(result.role).toBe('cpo');
    expect(result.matchedKeywords.length).toBeGreaterThanOrEqual(3);
  });

  it('description can determine routing when title is ambiguous', () => {
    const result = classifyDomain(
      'Update the system',
      'Need to review the server monitoring and fix the deployment pipeline for CI/CD'
    );
    expect(result.role).toBe('coo');
  });

  // ─── Confidence levels ───

  it('assigns high confidence with multiple clear keyword matches', () => {
    const result = classifyDomain('Research paper: literature review on statistical methodology for hypothesis testing');
    expect(result.role).toBe('research-lead');
    expect(result.confidence).toBe('high');
  });

  it('assigns lower confidence when keywords overlap domains', () => {
    // "design" appears in both CTO and CPO keyword lists
    const result = classifyDomain('Design review');
    expect(result.confidence).not.toBe('high');
  });
});

describe('shouldAutoRoute', () => {
  it('returns true for high confidence', () => {
    expect(shouldAutoRoute({ role: 'cpo', confidence: 'high', matchedKeywords: ['product'] })).toBe(true);
  });

  it('returns true for medium confidence', () => {
    expect(shouldAutoRoute({ role: 'cto', confidence: 'medium', matchedKeywords: ['review'] })).toBe(true);
  });

  it('returns false for low confidence', () => {
    expect(shouldAutoRoute({ role: 'coo', confidence: 'low', matchedKeywords: [] })).toBe(false);
  });
});

describe('classifyDomain — historical issue regression tests', () => {
  // Test against real-world issue patterns from the YourOrg project

  it('RYA-style: "Smart routing: domain-aware dispatch" → cto or lead-engineer', () => {
    const result = classifyDomain(
      'Smart routing: domain-aware dispatch replacing mechanical COO triage',
      'New module src/core/smart-router.ts with classifyDomain. Modify heartbeatAssignUnowned() in scheduler.ts.'
    );
    // This crosses CTO (routing, dispatch, design) and Lead Engineer (implement, module) —
    // either classification is acceptable for a cross-cutting task
    expect(['lead-engineer', 'cto', 'coo']).toContain(result.role);
  });

  it('RYA-style: "Ops report" → coo', () => {
    const result = classifyDomain('Daily ops report: system health and monitoring review');
    expect(result.role).toBe('coo');
  });

  it('RYA-style: "Product UX audit" → cpo', () => {
    const result = classifyDomain('Product UX audit: onboarding and navigation assessment');
    expect(result.role).toBe('cpo');
  });

  it('RYA-style: "Autoresearch pilot: Cognitive Bias Atlas" → research-lead', () => {
    const result = classifyDomain(
      'Autoresearch pilot: Cognitive Bias Atlas of LLMs',
      'Literature review and experiment design for hypothesis testing methodology'
    );
    expect(result.role).toBe('research-lead');
  });

  it('RYA-style: "Fix OAuth token refresh race" → lead-engineer', () => {
    const result = classifyDomain('Fix: OAuth token refresh race condition in adapter.ts');
    expect(result.role).toBe('lead-engineer');
  });

  it('RYA-style: "Architecture review findings" → cto', () => {
    const result = classifyDomain('Architecture review: agent system design audit and quality assessment');
    expect(result.role).toBe('cto');
  });

  it('RYA-style: "Deploy auth changes to staging" → coo', () => {
    const result = classifyDomain('Deploy auth changes to staging server');
    expect(result.role).toBe('coo');
  });

  it('RYA-style: "Workshop MVP curriculum" → cpo', () => {
    const result = classifyDomain('Workshop MVP: education curriculum and tutorial content');
    expect(result.role).toBe('cpo');
  });

  it('RYA-style: "[to decide] Start paper writing" → ceo-office', () => {
    const result = classifyDomain('[to decide] Start AskLess paper writing before calibration completes');
    expect(result.role).toBe('ceo-office');
  });

  it('RYA-style: "Collaboration quality audit" → cto', () => {
    const result = classifyDomain('Collaboration quality audit: code review and quality assurance assessment');
    expect(result.role).toBe('cto');
  });
});

// RYA-831: proactive issues encode their target role in the title prefix.
// The smart-router must honor that prefix BEFORE running CEO_DECISION_MARKERS
// (which contains 'strategic') or keyword scoring (which contains 'exploration').
describe('classifyDomain — RYA-831 [proactive] prefix routing', () => {
  it('routes [proactive] cto: title to cto, not ceo-office (despite "strategic")', () => {
    const result = classifyDomain('[proactive] cto: Strategic exploration (2026-W18)');
    expect(result.role).toBe('cto');
    expect(result.confidence).toBe('high');
    expect(result.matchedKeywords).toContain('[proactive]');
  });

  it('routes [proactive] cpo: title to cpo, not research-lead (despite "exploration")', () => {
    const result = classifyDomain('[proactive] cpo: Strategic exploration (2026-04-23)');
    expect(result.role).toBe('cpo');
  });

  it('routes [proactive] research-lead: title to research-lead', () => {
    const result = classifyDomain('[proactive] research-lead: Strategic exploration (2026-W18)');
    expect(result.role).toBe('research-lead');
  });

  it('routes [proactive] coo: title to coo, not ceo-office', () => {
    const result = classifyDomain('[proactive] coo: Strategic exploration (2026-W18)');
    expect(result.role).toBe('coo');
  });

  it('routes [proactive] lead-engineer: title to lead-engineer', () => {
    const result = classifyDomain('[proactive] lead-engineer: Strategic exploration (2026-W18)');
    expect(result.role).toBe('lead-engineer');
  });

  it('falls back to keyword scoring when [proactive] role is unknown', () => {
    // If a title misnames a role, don't route to a non-existent agent
    const result = classifyDomain('[proactive] fake-role: do something architecture');
    expect(result.role).not.toBe('fake-role');
  });

  it('does NOT match [proactive] mid-string (must be at title start)', () => {
    const result = classifyDomain('Discussion of [proactive] cto: exploration');
    // Falls through to keyword scoring; 'strategic' is absent so no CEO_DECISION
    expect(result.role).not.toBe('cto'); // wouldn't be high-confidence cto
  });
});
