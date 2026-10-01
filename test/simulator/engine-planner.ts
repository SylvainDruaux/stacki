// The planner the simulator's actor runs: the shipping planner,
// shared/engine/planner.ts. Until step 6 this module split the operations between it
// and the step-1 reference planner; from step 6 the shipping planner plans
// every operation, mapped through the diff when the intent is stale, so the
// simulator exercises exactly what ships (plan §10, invariant 9 by
// construction). Kept as the simulator's one seam for the planner.
import type { Intent, RejectionReason } from '#dist/shared/engine/intent.js';
import { planIntent, type Plan, type PlanningBase } from '#dist/shared/engine/planner.js';
import type { Result } from '#dist/shared/core/result.js';

export function planEngine(base: PlanningBase, intent: Intent): Result<Plan, RejectionReason> {
  return planIntent(base, intent);
}
