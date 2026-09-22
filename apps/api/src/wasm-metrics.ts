/** Observe exported memory during this isolated Worker's initialization, without replacing WASM bytes. */
export async function measureWasmInitialization(initialize: () => Promise<void>) {
  const original = WebAssembly.instantiate,
    memories = new Set<WebAssembly.Memory>();
  WebAssembly.instantiate = (async (...args: unknown[]) => {
    const result: unknown = await Reflect.apply(original, WebAssembly, args);
    const instance =
      result instanceof WebAssembly.Instance
        ? result
        : (result as WebAssembly.WebAssemblyInstantiatedSource).instance;
    for (const value of Object.values(instance.exports))
      if (value instanceof WebAssembly.Memory) memories.add(value);
    return result;
  }) as typeof WebAssembly.instantiate;
  try {
    await initialize();
  } finally {
    WebAssembly.instantiate = original;
  }
  if (memories.size !== 1) throw new Error('Expected one measured physics WASM memory');
  return () => [...memories].reduce((bytes, memory) => bytes + memory.buffer.byteLength, 0);
}
