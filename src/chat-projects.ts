/** Translate human project names at the local UI boundary; provider context keeps opaque IDs. */
export function projectNames(repos: readonly string[]): string[] {
  return repos.map(repo => repo.split("/").filter(Boolean).pop() ?? repo);
}

export function encodeProjectMentions(text: string, repos: readonly string[]): string {
  const names = projectNames(repos);
  const entries = repos.flatMap((repo, index) => {
    const name = names[index]!;
    const unique = names.filter(one => one.toLocaleLowerCase() === name.toLocaleLowerCase()).length === 1;
    return [{ name: repo, id: `r${index + 1}` }, ...(unique ? [{ name, id: `r${index + 1}` }] : [])];
  }).sort((a, b) => b.name.length - a.name.length);
  for (const entry of entries) {
    const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"), entry.id);
  }
  return text;
}

export function decodeProjectMentions(text: string, repos: readonly string[]): string {
  const names = projectNames(repos);
  return text.replace(/\br([1-9][0-9]*)\b/g, (whole, index: string) => names[Number(index) - 1] ?? whole);
}
