export function preserveOpenApiPathOrder<T>(previousPaths: Record<string, T>, currentPaths: Record<string, T>): Record<string, T> {
  const retainedPaths = Object.keys(previousPaths).filter((route) => Object.hasOwn(currentPaths, route));
  const addedPaths = Object.keys(currentPaths).filter((route) => !Object.hasOwn(previousPaths, route)).sort();
  return Object.fromEntries([...retainedPaths, ...addedPaths].map((route) => [route, currentPaths[route]!])) as Record<string, T>;
}
