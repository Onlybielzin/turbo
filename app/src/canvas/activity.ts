/**
 * PTY activity tracker — records the last time each terminal node emitted
 * output, so the UI can tell "an agent is actively working" apart from "a
 * terminal exists but is idle at its prompt".
 *
 * Kept as a module-level Map (not React state) so recording on every PTY chunk
 * is cheap and never triggers re-renders. Consumers poll `isActive()` on their
 * own tick.
 */
const lastActivity = new Map<string, number>();

/** Stamp that `nodeId` just produced PTY output. */
export function markActivity(nodeId: string): void {
  lastActivity.set(nodeId, Date.now());
}

/** True if `nodeId` produced output within the last `windowMs` (default 2.5s). */
export function isActive(nodeId: string, windowMs = 2500): boolean {
  const t = lastActivity.get(nodeId);
  return t !== undefined && Date.now() - t < windowMs;
}
