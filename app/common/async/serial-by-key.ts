/** 同一进程内按资源排队。前一个操作失败后，后续操作仍能继续。 */
export class SerialByKey {
  private readonly pending = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const current = (this.pending.get(key) ?? Promise.resolve()).then(work, work);
    this.pending.set(key, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }
}
