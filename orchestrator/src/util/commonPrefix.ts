/**
 * @file orchestrator/src/util/commonPrefix.ts
 * @stamp 2026-08-13
 * @architectural-role Pure Function — longest common prefix over two strings
 * @description
 * The byte-prefix diff behind the Prompt Inspector's cache-coverage badges
 * (docs/prompt-inspector-tag-tree.md §3.2): the provider's prompt cache is a prefix cache, so
 * the longest common prefix of two fired main-prompt texts is exactly how much of the later one
 * was replayed from cache (modulo eviction) at the moment it fired. Offsets are UTF-16 code
 * units — the same units promptTagTree.ts's section offsets and the frontend's slice() use — so
 * the result composes directly with section.start/end comparisons.
 */
export function longestCommonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}
