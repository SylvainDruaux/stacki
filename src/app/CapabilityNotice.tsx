// The selected node's capability, shown beside its panels when it changes what
// an edit means (plan §6, step 7): a node a loop repeats edits every copy, code
// the engine keeps verbatim is edited in the code panel, and a page outside the
// engine says so. A fallback is visible, never silent.
import { describeCapability, type Capability } from '../../shared/page/capability';
import { capabilityNeedsNotice } from '../editor/nodeCapability';

interface CapabilityNoticeProps {
  readonly capability: Capability | undefined;
}

export default function CapabilityNotice({ capability }: CapabilityNoticeProps) {
  if (capability === undefined) {
    return undefined;
  }
  if (!capabilityNeedsNotice(capability)) {
    return undefined;
  }
  return (
    <div className="capability-notice" role="status" data-capability={capability}>
      {describeCapability(capability)}
    </div>
  );
}
