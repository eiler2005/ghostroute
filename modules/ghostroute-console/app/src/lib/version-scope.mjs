// A synchronous build uses a consistent version; every later build rechecks it.
export function createSynchronousVersionScope(readVersion) {
  let current;
  return {
    current: () => current,
    run(build) {
      if (current !== undefined) return build();
      current = readVersion();
      try { return build(); } finally { current = undefined; }
    },
  };
}
