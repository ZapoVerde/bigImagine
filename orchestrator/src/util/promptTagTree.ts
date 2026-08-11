/**
 * @file orchestrator/src/util/promptTagTree.ts
 * @stamp 2026-08-13
 * @architectural-role Pure Function — loss-tolerant tag-tree parser over joined prompt text
 * @description
 * Groups a prompt-stack's joined text into sections by the author's own HTML-style tags
 * (<main_instructions>, <constraints>, <No Deepity>, ...). A section exists only when BOTH its
 * open and close tags match; every unmatched tag (missing close, dangling close, crossed pair,
 * self-closing, unknown) is inert text that stays at the enclosing level — nothing is ever
 * dropped, reordered, or hidden, so a broken tag only changes which level its text displays at.
 * This is the "rolls back up to the next level up" contract from docs/plans/prompt-inspector-tag-tree.md
 * §2. Display-only: the tree is computed from text that was already sent to the model and never
 * feeds back into any assembly path (bi_principles.md §17).
 *
 * Matching rules (see the spec for the worked examples):
 *   - parse the JOINED text, not per-item — a pair may span prompt-stack slots;
 *   - canonical names strip attributes: <memory turns="1"> matches </memory>; <inner thoughts>
 *     and <No Deepity> (no '=' anywhere) keep their full spaced names;
 *   - a close </X> matches the NEAREST open X on the stack; frames above it are recovery-closed
 *     (their completed children roll up into X in document order), crossed pairs degrade to the
 *     outer section only;
 *   - frames still open at EOF are not sections; their completed children roll up to the root.
 *
 * @api-declaration
 * parsePromptTagTree(text) — returns the root PromptTagSection spanning [0, text.length) whose
 * children are the matched, non-overlapping sections in document order. Root-only when no tags
 * match, so callers degrade to a single block exactly like today.
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export interface PromptTagSection {
  /** Canonical tag name (attributes stripped); empty only for the root. */
  name: string;
  /** Char offsets into the source text — [start, end) of the full span, tags included. */
  start: number;
  end: number;
  /** Offsets of this section's OWN content, i.e. [start, end) with its own open/close tag bytes
   *  excluded — `start`/`end` for the root, which has no wrapper tag of its own. A consumer
   *  rendering "this section's text minus its children" should slice [contentStart, contentEnd)
   *  rather than [start, end): using the tag-included span there means a section whose entire
   *  body is delegated to a single nested child renders as just its own two tag lines with
   *  nothing between them — indistinguishable from "no content" even though the child holds real
   *  text. Token/char accounting still wants the tag-included [start, end) span (those bytes are
   *  really sent to the model), so this is additive, not a replacement for start/end. */
  contentStart: number;
  contentEnd: number;
  /** Direct children in document order. */
  children: PromptTagSection[];
}

interface OpenFrame {
  name: string;
  start: number;
  contentStart: number;
  children: PromptTagSection[];
}

const TAG_TOKEN_RE = /<(\/)?([^<>]+?)>/g;

/**
 * Turns a tag's raw inner text into its canonical name, or null when the token is not a tag.
 * Rejects: empty, raw names with leading/trailing whitespace (kills prose like "a < b > c"),
 * and self-closing tags (`<br/>` — the caller drops the token entirely).
 */
function canonicalName(raw: string): string | null {
  if (raw.endsWith('/')) return null; // self-closing — inert
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (raw[0] !== trimmed[0] || raw[raw.length - 1] !== trimmed[trimmed.length - 1]) return null;
  const eq = trimmed.indexOf('=');
  if (eq === -1) return trimmed;
  // Attribute separator: the name is everything before the LAST whitespace run that precedes the
  // first '=' — `<memory turns="1-3">` names `memory`, `<a = 1>` names `a`, `<foo=bar>` names
  // `foo`; a tag with no '=' at all keeps its full spaced name (`<inner thoughts>`).
  const prefix = trimmed.slice(0, eq);
  const ws = prefix.search(/\s+\S*$/);
  const name = (ws === -1 ? prefix : prefix.slice(0, ws)).trim();
  return name.length > 0 ? name : null;
}

/**
 * Loss-tolerant tag-tree parse. See the file preamble and docs/plans/prompt-inspector-tag-tree.md §2
 * for the contract; the losslessness invariant (walking the tree in document order reproduces
 * the input byte-for-byte) is asserted by orchestrator/scripts/verify-prompt-tag-tree.mjs.
 */
export function parsePromptTagTree(text: string): PromptTagSection {
  const root: PromptTagSection = { name: '', start: 0, end: text.length, contentStart: 0, contentEnd: text.length, children: [] };
  const stack: OpenFrame[] = [];

  TAG_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_TOKEN_RE.exec(text)) !== null) {
    const name = canonicalName(match[2]);
    if (name === null) continue;

    if (match[1] !== '/') {
      // contentStart = right after this open tag's own '>' — the open tag itself (match[0])
      // can't contain another '<' or '>' (the token regex excludes them), so this is exact.
      stack.push({ name, start: match.index, contentStart: match.index + match[0].length, children: [] });
      continue;
    }

    // Close token: match the NEAREST open frame with this name, top-down.
    let openIndex = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === name) {
        openIndex = i;
        break;
      }
    }
    if (openIndex === -1) continue; // dangling close — inert text

    // Recovery: frames above the matched one are implicitly closed (they are NOT sections —
    // their text rolls into the surviving one); their completed children roll up in document
    // order (bottom-up, so earlier-opened frames' children come first).
    const frame = stack[openIndex];
    for (let i = openIndex + 1; i < stack.length; i++) {
      frame.children.push(...stack[i].children);
    }
    stack.length = openIndex; // pop the matched frame and everything above it

    const section: PromptTagSection = {
      name: frame.name,
      start: frame.start,
      end: match.index + match[0].length,
      contentStart: frame.contentStart,
      // contentEnd = right before this close tag's own '<' — match.index is exactly that.
      contentEnd: match.index,
      children: frame.children,
    };
    const parent = stack.length > 0 ? stack[stack.length - 1] : root;
    parent.children.push(section);
  }

  // Frames still open at EOF have no matching close → not sections; their completed children
  // roll up to the root in document order.
  for (const frame of stack) root.children.push(...frame.children);

  return root;
}
