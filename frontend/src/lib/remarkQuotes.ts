import { visit } from 'unist-util-visit';
import type { Plugin } from 'unified';
import type { Root, Text, PhrasingContent, Parent } from 'mdast';

// Mirrors SillyTavern's messageFormatting() quote handling (public/script.js): wraps spoken
// dialogue in a <q> element so it can be colored separately from surrounding prose. Operates on
// already-parsed mdast text nodes rather than the raw string, so — unlike ST, which has to
// explicitly dodge backtick-fenced spans in its regex — code blocks and inline code are never
// touched here; they're already separate 'code'/'inlineCode' node types the visitor never visits.
const QUOTE_RE =
  /(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/g;

const remarkQuotes: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return;

    QUOTE_RE.lastIndex = 0;
    if (!QUOTE_RE.test(node.value)) return;
    QUOTE_RE.lastIndex = 0;

    const replacement: PhrasingContent[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = QUOTE_RE.exec(node.value))) {
      if (match.index > cursor) {
        replacement.push({ type: 'text', value: node.value.slice(cursor, match.index) });
      }
      // data.hName tells mdast-util-to-hast to render this as a <q> element — the standard,
      // sanitizer-safe way to introduce a custom element from a remark plugin (no raw HTML, so
      // nothing here can be used to smuggle a tag other than <q> through message content).
      replacement.push({
        type: 'q',
        data: { hName: 'q' },
        children: [{ type: 'text', value: match[0] }],
      } as unknown as PhrasingContent);
      cursor = match.index + match[0].length;
    }
    if (cursor < node.value.length) {
      replacement.push({ type: 'text', value: node.value.slice(cursor) });
    }

    parent.children.splice(index, 1, ...replacement);
    // Skip past the nodes we just inserted — their inner text (the quoted span, quote characters
    // included) would otherwise re-match on the next visit and nest <q> indefinitely.
    return index + replacement.length;
  });
};

export default remarkQuotes;
