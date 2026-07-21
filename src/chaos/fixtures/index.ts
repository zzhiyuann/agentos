/**
 * Registry of all regression fixtures.
 *
 * The CI gate (`chaos-regression` job in .github/workflows/ci.yml) and the
 * pre-commit hook both consume this list. Adding a fixture is the only step
 * needed to extend the gate — see src/chaos/README.md.
 *
 * Order is alphabetical by id so failures appear in a stable order in CI logs.
 */

import type { RegressionFixture } from './types.js';
import { fixture as kfp1SilentFailureSwallow } from './kfp-1-silent-failure-swallow.js';
import { fixture as kfp5ZombieSpawnLoop } from './kfp-5-zombie-spawn-loop.js';

export const fixtures: RegressionFixture[] = [
  kfp1SilentFailureSwallow,
  kfp5ZombieSpawnLoop,
];

export type { RegressionFixture, RegressionResult, RegressionRunSummary } from './types.js';
