import type { Plugin } from 'unified';
import type { Root, Text, PhrasingContent, Parent, Nodes } from 'mdast';

// Mirrors SillyTavern's messageFormatting() quote handling (public/script.js): wraps spoken
// dialogue in a <q> element so it can be colored separately from surrounding prose. Operates on
// already-parsed mdast rather than the raw string, so — unlike ST, which has to explicitly dodge
// backtick-fenced spans in its regex — code blocks and inline code are never touched here;
// they're already separate 'code'/'inlineCode' node types that never contribute quote characters.
//
// One step beyond ST: the quoted span is matched across the parent's concatenated text nodes
// instead of one text node at a time. Markup inside the dialogue ("I love *pizza*,") splits the
// span across several mdast nodes, so the whole run — literal text plus any nested phrasing
// (emphasis/strong/inline code) — is wrapped in a single <q>. That keeps the dialogue's colour
// applied to the entire span while the inner emphasis keeps its italic accent (see
// `.markdown-content q em { color: inherit }` in ChatView.css).
const QUOTE_RE =
  /(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/g;

const remarkQuotes: Plugin<[], Root> = () => (tree) => {
  walk(tree);
};

function walk(node: Nodes): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;
  // Bottom-up: recurse into children first, so nested phrasing (emphasis inside a paragraph,
  // etc.) is handled before this parent's own text, and so the <q> nodes spliced in by
  // processParent are never re-walked (their inner text would otherwise re-match and nest <q>).
  for (const child of node.children) walk(child);
  if (node.children.some((c) => c.type === 'text')) {
    processParent(node as Parent);
  }
}

function processParent(parent: Parent): void {
  // Flatten the parent's direct text children into one stream, remembering where each node
  // starts so a match's character offsets can be mapped back onto the original child nodes.
  const textIdx: number[] = [];
  const starts: number[] = [];
  let concat = '';
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.type === 'text') {
      textIdx.push(i);
      starts.push(concat.length);
      concat += child.value;
    }
  }
  if (textIdx.length === 0) return;

  QUOTE_RE.lastIndex = 0;
  if (!QUOTE_RE.test(concat)) return;
  QUOTE_RE.lastIndex = 0;

  const matches: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = QUOTE_RE.exec(concat))) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }

  // Apply right-to-left so the child indices from the original snapshot stay valid while we
  // splice. Matches are disjoint, so an earlier match always operates on a node (or prefix of a
  // node) that a later match's splice has left intact.
  for (let k = matches.length - 1; k >= 0; k--) {
    const { start, end } = matches[k];
    // First text node containing `start`; last text node containing `end - 1`.
    let i = 0;
    while (i < textIdx.length - 1 && starts[i + 1] <= start) i++;
    let j = i;
    while (j < textIdx.length - 1 && starts[j + 1] < end) j++;

    const firstIdx = textIdx[i];
    const lastIdx = textIdx[j];
    const first = parent.children[firstIdx] as Text;
    const last = parent.children[lastIdx] as Text;

    const qChildren: PhrasingContent[] = [];
    if (i === j) {
      // Whole match inside one text node (the common case).
      qChildren.push({
        type: 'text',
        value: first.value.slice(start - starts[i], end - starts[i]),
      } as Text);
    } else {
      // Split the boundary text nodes; every node between them — emphasis/strong/code inside
      // the quoted span — goes into the <q> whole.
      qChildren.push({ type: 'text', value: first.value.slice(start - starts[i]) } as Text);
      for (let c = firstIdx + 1; c < lastIdx; c++) {
        qChildren.push(parent.children[c] as PhrasingContent);
      }
      qChildren.push({ type: 'text', value: last.value.slice(0, end - starts[j]) } as Text);
    }

    // data.hName tells mdast-util-to-hast to render this as a <q> element — the standard,
    // sanitizer-safe way to introduce a custom element from a remark plugin (no raw HTML, so
    // nothing here can be used to smuggle a tag other than <q> through message content).
    const q = {
      type: 'q',
      data: { hName: 'q' },
      children: qChildren,
    } as unknown as PhrasingContent;

    const replacement: PhrasingContent[] = [];
    const prefix = first.value.slice(0, start - starts[i]);
    const suffix = last.value.slice(end - starts[j]);
    if (prefix.length > 0) replacement.push({ type: 'text', value: prefix } as Text);
    replacement.push(q);
    if (suffix.length > 0) replacement.push({ type: 'text', value: suffix } as Text);

    parent.children.splice(firstIdx, lastIdx - firstIdx + 1, ...replacement);
  }
}

export default remarkQuotes;
