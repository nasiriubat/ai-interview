/** Who did something: their name when they have one, else their address, else `fallback`. */
export function actorLabel(
  actor: { name?: string | null | undefined; email: string } | null | undefined,
  fallback: string,
): string {
  if (!actor) return fallback;
  // A blank name is a name nobody set.
  const name = actor.name?.trim();
  if (name !== undefined && name !== "") return name;
  return actor.email;
}
