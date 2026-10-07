type Entry<Value> = { readonly value: Value } | { readonly pending: Promise<Value> };

/** Bounded cache; completed requests retain values, never their async context. */
export class AsyncLruCache<Key, Value> {
  private readonly entries = new Map<Key, Entry<Value>>();

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Cache capacity must be positive");
  }

  get size(): number { return this.entries.size; }

  getOrLoad(key: Key, load: () => Promise<Value>): Promise<Value> {
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return "pending" in cached ? cached.pending : Promise.resolve(cached.value);
    }
    const pending = Promise.resolve().then(load);
    const entry = { pending };
    this.entries.set(key, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    // An evicted request must not replace a newer request for the same key.
    void pending.then((value) => {
      if (this.entries.get(key) === entry) this.entries.set(key, { value });
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return pending;
  }
}
