/** Stale cancellation events cannot unfreeze a later close/restart request. */
export class ShutdownToken {
  private value: string | null = null;
  get active(): boolean { return this.value !== null; }
  freeze(token: string): void { this.value = token; }
  release(token: string): boolean { if (this.value !== token) return false; this.value = null; return true; }
}
