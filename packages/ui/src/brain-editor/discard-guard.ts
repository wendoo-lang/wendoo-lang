/**
 * What the brain editor knows about the work its session has accumulated, read
 * at the moment a discarding exit is requested.
 */
export interface DiscardGuardReading {
  /** Entries on the command history's undo stack right now. */
  undoDepth: number;
  /**
   * Undo depth the editor had reached on its own before the user could act: 1
   * when the editor appended a starting rule to a brain that held none, else 0.
   */
  openingDepth: number;
}

/**
 * Whether closing the brain editor now would throw away work the user did.
 *
 * A brain the user only opened is not dirty, including one the editor gave a
 * starting rule to on open. Every change the user makes, a whole brain loaded
 * over the working copy included, is a step on the command history, so
 * undoing back to the opening state clears the reading again.
 *
 * @param reading - The editor's session counters.
 * @returns True when the session holds user work that a discard would lose.
 */
export function hasDiscardableEdits(reading: DiscardGuardReading): boolean {
  return reading.undoDepth > reading.openingDepth;
}
