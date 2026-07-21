import { describe, it, expect } from 'vitest';
import { isNoiseIssue, isTriageIssue } from './noise-filter.js';

describe('isNoiseIssue', () => {
  describe('proactive machinery', () => {
    it('matches [proactive] prefix', () => {
      expect(isNoiseIssue('[proactive] cpo: Strategic exploration')).toBe(true);
      expect(isNoiseIssue('[proactive idea] new wedge')).toBe(true);
      expect(isNoiseIssue('[PROACTIVE] case insensitive')).toBe(true);
    });

    it('matches [idea] prefix', () => {
      expect(isNoiseIssue('[idea] explore X')).toBe(true);
    });

    it('matches "Proactive:" / "Proactive Hub" / "Proactive idea"', () => {
      expect(isNoiseIssue('Proactive: Strategic Exploration Hub')).toBe(true);
      expect(isNoiseIssue('Proactive Hub for cpo')).toBe(true);
      expect(isNoiseIssue('Proactive idea: ship Y')).toBe(true);
    });

    it('matches vote-on-RYA pattern', () => {
      expect(isNoiseIssue('Board vote on RYA-123 — ship X')).toBe(true);
    });

    it('matches Strategic Exploration Hub anywhere', () => {
      expect(isNoiseIssue('cpo Strategic Exploration Hub for W19')).toBe(true);
    });

    it('matches "Set up proactive" prefix', () => {
      expect(isNoiseIssue('Set up proactive scheduler for cto')).toBe(true);
    });

    it('matches Board vote protocol', () => {
      expect(isNoiseIssue('cto Board vote protocol — ratify Y')).toBe(true);
    });

    it('matches transformative-proposal scaffolding', () => {
      expect(isNoiseIssue('Propose 2-3 transformative changes for Q3')).toBe(true);
    });
  });

  describe('[to decide] issues — must not be auto-dispatched (RYA-970)', () => {
    it('matches plain [to decide] prefix', () => {
      expect(isNoiseIssue('[to decide] Redefine distill FP threshold')).toBe(true);
    });

    it('matches [to decide] case-insensitive', () => {
      expect(isNoiseIssue('[TO DECIDE] uppercase variant')).toBe(true);
      expect(isNoiseIssue('[To Decide] mixed case')).toBe(true);
    });

    it('matches [to decide] with leading whitespace', () => {
      expect(isNoiseIssue('  [to decide] padded title')).toBe(true);
      expect(isNoiseIssue('\t[to decide] tab-prefixed')).toBe(true);
    });

    it('does NOT match when [to decide] is mid-title (only prefix qualifies)', () => {
      expect(isNoiseIssue('Some title — [to decide] later')).toBe(false);
      expect(isNoiseIssue('Decision pending [to decide]')).toBe(false);
    });

    it('does NOT match without the brackets', () => {
      expect(isNoiseIssue('to decide what to ship')).toBe(false);
    });
  });

  describe('Daily triage:* issues — only ceoOfficeTriageHeartbeat dispatches them (RYA-1205)', () => {
    it('matches the auto-generated triage title', () => {
      expect(isNoiseIssue('Daily triage: 13 issues In Review')).toBe(true);
      expect(isTriageIssue('Daily triage: 13 issues In Review')).toBe(true);
    });

    it('matches case-insensitively', () => {
      expect(isTriageIssue('daily triage: 5 issues In Review')).toBe(true);
    });

    it('does NOT match mid-title mentions', () => {
      expect(isNoiseIssue('Fix: Daily triage: trigger self-feeds')).toBe(false);
      expect(isTriageIssue('Fix the Daily triage: loop')).toBe(false);
    });

    it('isTriageIssue handles null/undefined', () => {
      expect(isTriageIssue(null)).toBe(false);
      expect(isTriageIssue(undefined)).toBe(false);
    });
  });

  describe('non-noise titles pass through', () => {
    it('rejects ordinary work titles', () => {
      expect(isNoiseIssue('Fix CLI parsing in distill apply')).toBe(false);
      expect(isNoiseIssue('RYA-967: Distill CLI + launchd schedule')).toBe(false);
      expect(isNoiseIssue('Review provenance schema')).toBe(false);
    });

    it('handles null/undefined/empty', () => {
      expect(isNoiseIssue(null)).toBe(false);
      expect(isNoiseIssue(undefined)).toBe(false);
      expect(isNoiseIssue('')).toBe(false);
    });
  });
});
