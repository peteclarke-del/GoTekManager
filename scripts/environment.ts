/**
 * Browser globals the domain and state modules expect.
 *
 * Imported first by the checks so that modules reading `localStorage` at load
 * time see a working store. ES module evaluation order guarantees this file
 * runs before anything that imports it does.
 */

class MemoryStorage implements Storage {
  private entries = new Map<string, string>()

  get length(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  getItem(key: string): string | null {
    return this.entries.has(key) ? (this.entries.get(key) as string) : null
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value))
  }
}

export const storage = new MemoryStorage()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).localStorage = storage
