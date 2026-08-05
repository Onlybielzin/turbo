/**
 * layout.ts — Radial/fan positioning for child TerminalNodes spawned by a parent agent.
 *
 * Design: children fan out around the parent node at a fixed radius.
 * - First child: directly to the right (angle 0).
 * - Subsequent children: spread evenly across a 180° arc (right half).
 * - Angles are in radians measured from the positive x-axis.
 * - Positions are relative to the GroupFrame (parentId extent:'parent').
 *
 * Phase 4: D-01 decision — fan/radial layout, graceful degradation on many children.
 */

/** Dimensions of a spawned child TerminalNode (px, relative to group interior). */
export const CHILD_NODE_WIDTH = 620;
export const CHILD_NODE_HEIGHT = 420;

/** Radius from parent centre to child centre (px). */
const FAN_RADIUS = 560;

/** Arc spread for the fan (radians). 0 = rightward, π = full half-circle. */
const FAN_SPREAD = Math.PI * 0.8; // ~144° arc — readable fan

/** Starting angle (radians). π/2 below horizontal so the fan opens to the right. */
const FAN_START = -FAN_SPREAD / 2;

/**
 * Compute the position (relative to GroupFrame interior) for the `index`-th child
 * of a parent node located at `parentPosition` (also relative to the GroupFrame).
 *
 * `totalChildren` is the current total (including the one being placed).
 */
export function childPosition(
  parentPosition: { x: number; y: number },
  index: number,
  totalChildren: number,
): { x: number; y: number } {
  // With a single child, place it directly to the right.
  const angle =
    totalChildren === 1
      ? 0
      : FAN_START + (index / (totalChildren - 1)) * FAN_SPREAD;

  const cx = parentPosition.x + FAN_RADIUS * Math.cos(angle) - CHILD_NODE_WIDTH / 2;
  const cy = parentPosition.y + FAN_RADIUS * Math.sin(angle) - CHILD_NODE_HEIGHT / 2;

  // Clamp to reasonable minimum offset from group top-left (32px inner padding).
  return {
    x: Math.max(32, cx),
    y: Math.max(60, cy), // 60 accounts for the 28px label bar + 32px pad
  };
}
