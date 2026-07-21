/**
 * Acceptance test for RYA-861: observer must achieve ≥80% precision AND
 * ≥80% recall on a labeled fixture set.
 *
 * Per-class metrics are computed from the confusion matrix; macro-averaged
 * precision/recall must both clear the 80% bar. Per-class precision/recall
 * are also asserted to ensure no single class collapses.
 */

import { describe, it, expect } from 'vitest';
import { classifyEvents } from './observer.js';
import { buildFixtures, LabeledFixture } from './labeled-fixtures.js';
import { OutcomeClass } from './types.js';

const CLASSES: OutcomeClass[] = [
  'detected_recovered',
  'detected_human_rescue',
  'undetected_recovered',
  'undetected_failed',
  'false_positive',
];

interface ClassMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

function computeMetrics(predictions: { gt: OutcomeClass; pred: OutcomeClass }[]): Record<OutcomeClass, ClassMetrics> {
  const out = {} as Record<OutcomeClass, ClassMetrics>;
  for (const cls of CLASSES) {
    const tp = predictions.filter(p => p.gt === cls && p.pred === cls).length;
    const fp = predictions.filter(p => p.gt !== cls && p.pred === cls).length;
    const fn = predictions.filter(p => p.gt === cls && p.pred !== cls).length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    out[cls] = { tp, fp, fn, precision, recall };
  }
  return out;
}

function macroAverage(metrics: Record<OutcomeClass, ClassMetrics>, key: 'precision' | 'recall'): number {
  const vals = CLASSES.map(c => metrics[c][key]);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

describe('chaos observer precision/recall on labeled fixtures', () => {
  const fixtures: LabeledFixture[] = buildFixtures();

  it('has ≥5 fixtures per outcome class', () => {
    for (const cls of CLASSES) {
      const count = fixtures.filter(f => f.groundTruth === cls).length;
      expect(count).toBeGreaterThanOrEqual(5);
    }
  });

  it('classifies all fixtures with ≥80% macro precision and recall', () => {
    const predictions = fixtures.map(f => {
      const startedAt = new Date(f.scenario.generatedAt).getTime();
      const endedAt = startedAt + f.scenario.injection.windowMs * 2;
      const outcome = classifyEvents(f.scenario, f.events, startedAt, endedAt);
      return { gt: f.groundTruth, pred: outcome.outcomeClass, id: f.id };
    });

    const metrics = computeMetrics(predictions);
    const macroP = macroAverage(metrics, 'precision');
    const macroR = macroAverage(metrics, 'recall');

    if (macroP < 0.8 || macroR < 0.8) {
      // Print confusion for debug.
      console.log('Predictions:');
      for (const p of predictions) console.log(`  ${p.id}: gt=${p.gt} pred=${p.pred}`);
      console.log('Per-class metrics:');
      for (const cls of CLASSES) {
        const m = metrics[cls];
        console.log(`  ${cls}: tp=${m.tp} fp=${m.fp} fn=${m.fn} P=${m.precision.toFixed(2)} R=${m.recall.toFixed(2)}`);
      }
    }

    expect(macroP).toBeGreaterThanOrEqual(0.8);
    expect(macroR).toBeGreaterThanOrEqual(0.8);
  });

  it('per-class precision is ≥80% for every class', () => {
    const predictions = fixtures.map(f => {
      const startedAt = new Date(f.scenario.generatedAt).getTime();
      const endedAt = startedAt + f.scenario.injection.windowMs * 2;
      return {
        gt: f.groundTruth,
        pred: classifyEvents(f.scenario, f.events, startedAt, endedAt).outcomeClass,
      };
    });
    const metrics = computeMetrics(predictions);
    for (const cls of CLASSES) {
      expect(metrics[cls].precision, `precision for ${cls}`).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('per-class recall is ≥80% for every class', () => {
    const predictions = fixtures.map(f => {
      const startedAt = new Date(f.scenario.generatedAt).getTime();
      const endedAt = startedAt + f.scenario.injection.windowMs * 2;
      return {
        gt: f.groundTruth,
        pred: classifyEvents(f.scenario, f.events, startedAt, endedAt).outcomeClass,
      };
    });
    const metrics = computeMetrics(predictions);
    for (const cls of CLASSES) {
      expect(metrics[cls].recall, `recall for ${cls}`).toBeGreaterThanOrEqual(0.8);
    }
  });
});
