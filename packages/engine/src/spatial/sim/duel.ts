/** Current combat is a duel: there must be exactly one distinct opponent. */
export function opponentInDuel<T>(
  actors: readonly T[],
  selfId: string,
  id: (actor: T) => string,
): T {
  if (actors.length !== 2) throw new Error('A duel requires exactly two actors');
  const first = actors[0]!,
    second = actors[1]!;
  const left = id(first),
    right = id(second);
  if (left === right || (left !== selfId && right !== selfId))
    throw new Error('A duel requires a known actor and a distinct opponent');
  return left === selfId ? second : first;
}
