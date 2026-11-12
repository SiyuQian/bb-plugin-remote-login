/** A trusted, local refusal before any browser input effect. Never decode arbitrary errors as this class. */
export class StaleFrameError extends Error {
  readonly code = "stale_frame";
  constructor() { super("The displayed frame is no longer current."); this.name = "StaleFrameError"; }
}

/** A known read-only capture change; it never means an earlier input was unsent. */
export class FrameChangedError extends Error {
  readonly code = "frame_changed";
  constructor() { super("The frame changed before it could be displayed."); this.name = "FrameChangedError"; }
}
