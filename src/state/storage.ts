/** Browser storage that degrades to memory when blocked (private mode, disabled site data). */

export type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function browserStorage(kind: 'local' | 'session'): KV {
  try {
    const s = kind === 'local' ? localStorage : sessionStorage;
    s.getItem('crate-digger:probe');
    return s;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    };
  }
}
