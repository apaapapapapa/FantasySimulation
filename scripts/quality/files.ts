export function firstPartyJavaScript(paths: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      /\.(?:js|mjs|cjs|jsx)$/.test(path) &&
      !/(?:^|\/)(?:node_modules|\.generated|dist)\//.test(path),
  );
}

export function unsupportedTypeScriptModules(paths: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      /\.(?:mts|cts)$/.test(path) && !/(?:^|\/)(?:node_modules|\.generated|dist)\//.test(path),
  );
}
