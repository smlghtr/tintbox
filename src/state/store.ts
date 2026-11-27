export type Equality<T> = (a: T, b: T) => boolean;

export interface Store<S> {
  getState: () => S;
  setState: (updater: Partial<S> | ((prev: S) => S)) => void;
  subscribe: <T>(selector: (s: S) => T, cb: (next: T, prev: T) => void, eq?: Equality<T>) => () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<(next: S, prev: S) => void>();

  function getState(): S {
    return state;
  }

  function setState(updater: Partial<S> | ((prev: S) => S)): void {
    const prev = state;
    const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
    if (Object.is(next, prev)) return;
    state = next;
    for (const fn of listeners) fn(next, prev);
  }

  function subscribe<T>(
    selector: (s: S) => T,
    cb: (next: T, prev: T) => void,
    eq: Equality<T> = Object.is,
  ): () => void {
    let last = selector(state);
    const wrapped = (next: S) => {
      const cur = selector(next);
      if (!eq(cur, last)) {
        const prev = last;
        last = cur;
        cb(cur, prev);
      }
    };
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }

  return { getState, setState, subscribe };
}
