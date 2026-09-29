// The planner the simulator's actor runs from step 3 (the spike): the shipping
// planner, shared/planner.ts, for the operations it plans — set-attribute,
// mapped through the diff when the intent is stale, and from step 5 the
// migration-only replace-source, never mapped — and the step-1 reference
// planner for every operation whose step has not shipped yet (6 and 8), which
// plans them against unchanged bytes only. Pure, like both halves (plan §5.2).
import type { Intent, RejectionReason } from '../../dist/shared/intent.js';
import { planIntent, type Plan, type PlanningBase } from '../../dist/shared/planner.js';
import type { Result } from '../../dist/shared/result.js';
import { planByIdentity } from './reference-planner.ts';

export function planEngine(base: PlanningBase, intent: Intent): Result<Plan, RejectionReason> {
  const operation = intent.operation;
  switch (operation.tag) {
    case 'set-attribute':
    case 'replace-source':
      return planIntent(base, intent);
    case 'remove-attribute':
    case 'insert-node':
    case 'move-node':
    case 'rename-binding':
    case 'set-inline-style':
    case 'edit-frontmatter-slot':
    case 'apply-code-patch':
      return planByIdentity(base.current, intent);
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unknown operation ${JSON.stringify(exhaustive)}`);
    }
  }
}
