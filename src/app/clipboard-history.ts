/** Opt-in, short-lived copies. JavaScript cannot guarantee physical memory zeroization. */
export class ClipboardHistory {
  private items: { text: string; at: number }[] = [];
  clear(): void { this.items = []; }
  values(now = Date.now()): string[] {
    this.items = this.items.filter(item => now - item.at < 120_000);
    return this.items.map(item => item.text);
  }
  remember(text: string, enabled: boolean, now = Date.now()): void {
    if (!enabled) { this.clear(); return; }
    this.values(now);
    if (!text.trim() || text.length > 65_536) return;
    this.items = [{ text, at: now }, ...this.items.filter(item => item.text !== text)].slice(0, 25);
  }
}
