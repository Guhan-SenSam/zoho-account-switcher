// In-memory fake of chrome.storage.local (promise API) for unit tests.
//
// - get(keys): null/undefined -> everything; string -> that key; string[] ->
//   those keys; object -> those keys with the object's values as defaults.
//   Missing keys are simply absent from the result.
// - set(items), remove(keys), clear().
// - Values are deep-cloned (structuredClone) on the way in and on the way out,
//   like the real thing, so callers can never alias stored state. Properties
//   whose value is `undefined` are not stored (Chrome drops them).
// - Operations take effect in call order (FIFO) but every promise resolves
//   asynchronously (after `latency` ms, default next macrotask), so an unguarded
//   read-modify-write can interleave with another one and lose writes.
//
// Test helpers: dump() returns a clone of everything, calls logs each call.

export function createFakeStorage(initial = {}, { latency = 0 } = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const calls = { get: [], set: [], remove: [], clear: 0 };

  const delay = () => (typeof latency === 'function' ? latency() : latency);
  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), delay()));

  function pick(keys) {
    if (keys === null || keys === undefined) return Object.fromEntries(data);
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (data.has(k)) out[k] = data.get(k);
      return out;
    }
    if (typeof keys === 'object') {
      const out = {};
      for (const [k, dflt] of Object.entries(keys)) out[k] = data.has(k) ? data.get(k) : dflt;
      return out;
    }
    throw new TypeError('Error in invocation of storage.get: invalid keys');
  }

  return {
    get(keys) {
      calls.get.push(keys);
      // Read now (FIFO), resolve later.
      return later(structuredClone(pick(keys)));
    },
    set(items) {
      if (items === null || typeof items !== 'object' || Array.isArray(items)) {
        throw new TypeError('Error in invocation of storage.set: items must be an object');
      }
      calls.set.push(Object.keys(items));
      const cloned = structuredClone(items);
      for (const [k, v] of Object.entries(cloned)) if (v !== undefined) data.set(k, v);
      return later(undefined);
    },
    remove(keys) {
      calls.remove.push(keys);
      for (const k of typeof keys === 'string' ? [keys] : keys) data.delete(k);
      return later(undefined);
    },
    clear() {
      calls.clear += 1;
      data.clear();
      return later(undefined);
    },
    calls,
    dump() {
      return structuredClone(Object.fromEntries(data));
    },
  };
}
