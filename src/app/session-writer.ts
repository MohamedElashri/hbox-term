/** Serialize session writes so periodic saves and quit cannot race on the temporary file. */
export class SessionWriter {
  private pending: Promise<void> = Promise.resolve();
  private lastSaved = "";
  private readonly persist: (contents: string) => Promise<void>;

  constructor(persist: (contents: string) => Promise<void>) {
    this.persist = persist;
  }

  save(contents: string): Promise<void> {
    const next = this.pending.then(async () => {
      if (contents === this.lastSaved) return;
      await this.persist(contents);
      this.lastSaved = contents;
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
}
