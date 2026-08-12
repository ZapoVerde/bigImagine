import { useCallback, useEffect, useState } from 'react';
import { parsePromptTagTree } from '@bigbrain/orchestrator/prompt-tag-tree';
import type { PromptTagSection } from '@bigbrain/orchestrator/prompt-tag-tree';
import { ApiError, getPromptPreview } from '../../api/client';
import { markerLabel } from '../../api/markerLabels';
import type { PromptPreview, PromptPreviewGroup, PromptPreviewItem } from '../../api/types';
import './PromptInspectorPanel.css';

interface PromptInspectorPanelProps {
  apiKey: string | null;
  chatId: string;
  /** Bumped once per completed chat turn (ChatView) so the panel re-fetches and reflects the
   *  latest exchange — the preview is a live read of current chat state, never cached beyond one
   *  fetch (bi_principles.md §13's live-read guarantee applied to this surface too). */
  refreshToken: number;
  /** Optional: when absent (the left-drawer mount), the × close button is hidden — the drawer
   *  collapses via its own arrow/FAB instead. */
  onClose?: () => void;
}

// docs/bi_principles.md §11/§18: an 'rp' chat's turn prompts are assembled fresh, server-side, and
// nothing about them is normally visible except the reply they produced. This panel is the
// read-only window onto them — one collapsible section per prompt the chat fired, in order: Main
// Prompt (the exact text the last turn sent — captured at send time server-side, io/promptTrace.ts
// kind 'main' — shown as a tag tree: grouped into collapsible sections by the author's own
// HTML-style tags via util/promptTagTree.ts, see docs/plans/completed/prompt-inspector-tag-tree.md), then each
// captured background prompt (cleanup pass, chat title generation, …) with its full actual text —
// and, when the trace captured one, the model's reply to that prompt (cleanup repair outputs are
// discarded the moment the cleaned text replaces them; the inspector is where they survive). Every
// block carries a rough token estimate so a household member can see what's actually eating
// context. ChatView bumps refreshToken once per completed turn, so the panel always shows the last
// turn that was sent.
export default function PromptInspectorPanel({ apiKey, chatId, refreshToken, onClose }: PromptInspectorPanelProps) {
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getPromptPreview(chatId, apiKey)
      .then(setPreview)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load prompt preview'))
      .finally(() => setLoading(false));
  }, [chatId, apiKey]);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  async function copyFullPrompt() {
    if (!preview) return;
    const full = preview.groups.flatMap((g) => g.items).map((i) => i.content).join('\n\n');
    try {
      await navigator.clipboard.writeText(full);
    } catch {
      return; // clipboard permission denied/unavailable — not worth an error banner
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="prompt-inspector-panel">
      <div className="prompt-inspector-header">
        <span className="prompt-inspector-title">Prompt Inspector</span>
        <div className="prompt-inspector-header-actions">
          <button type="button" className="prompt-inspector-refresh" title="Re-fetch the current prompt" onClick={load} disabled={loading}>
            ↻
          </button>
          <button
            type="button"
            className="prompt-inspector-copy"
            title="Copy the complete prompt as plain text"
            disabled={!preview}
            onClick={copyFullPrompt}
          >
            {copied ? 'Copied' : 'Copy all'}
          </button>
          {onClose && (
            <button type="button" className="prompt-inspector-close" title="Close prompt inspector" onClick={onClose}>
              &times;
            </button>
          )}
        </div>
      </div>

      <div className="prompt-inspector-content">
        {error && <div className="prompt-inspector-error">{error}</div>}
        {loading && !preview && <div className="prompt-inspector-loading">Loading…</div>}

        {preview && (
          <>
            <div className="prompt-inspector-stats">
              <span className="prompt-inspector-stats-total">{preview.totalEstimatedTokens.toLocaleString()} est. tokens</span>
            </div>

            {preview.groups.map((group, i) => (
              <PromptGroupSection key={`${group.kind}-${i}`} group={group} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// The receipt's $ figure — raw counts × raw per-million rates, USD. A pure function so the
// frontend is the single place this arithmetic lives (docs/plans/completed/prompt-inspector-usage-cost.md):
// the tokens are exactly what the server relayed, the rates exactly what the admin typed, and the
// derived figure can never drift from either. Returns undefined when any tier the calculation
// needs is unconfigured — the caller then omits the $ figure entirely rather than computing a
// partially-wrong total.
function computeReceiptCost(
  usage: NonNullable<PromptPreviewGroup['usage']>,
  price: NonNullable<PromptPreviewGroup['price']>,
): number | undefined {
  const needsCacheRate = usage.cacheReadTokens !== undefined;
  if (
    price.inputPerMillion === undefined ||
    price.outputPerMillion === undefined ||
    (needsCacheRate && price.cacheHitPerMillion === undefined)
  ) {
    return undefined;
  }
  const perMillion = 1_000_000;
  const cacheHit = usage.cacheReadTokens ?? 0;
  const cacheMiss = usage.promptTokens - cacheHit;
  return (
    (cacheMiss * price.inputPerMillion + cacheHit * (price.cacheHitPerMillion ?? 0)) / perMillion +
    (usage.completionTokens * price.outputPerMillion) / perMillion
  );
}

// Sub-cent figures are the norm for a single turn — show enough decimals to stay meaningful
// without trailing zeros past four places.
function formatUsd(cost: number): string {
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

function itemLabel(item: PromptPreviewItem): string {
  if (item.label) return item.label;
  if (item.markerKey) return markerLabel(item.markerKey);
  return item.role === 'user' ? 'User' : item.role === 'assistant' ? 'Assistant' : 'System';
}

// One collapsible section per prompt: the group title (Main Prompt / Cleanup Prompt / …), a
// "fired" badge when this is a captured prompt's actual sent text, and the prompt's text as
// collapsible blocks — plus, when the trace captured one, the model's reply as a block in the
// same style (labeled "Reply", role assistant). The Main Prompt — the full system stack plus the
// entire trimmed conversation history — is rendered as a TAG TREE: its sub-sections grouped by
// the author's own HTML-style tags, each a collapsible row with a token budget (the user's
// approved spec, docs/plans/completed/prompt-inspector-tag-tree.md). Matching is loss-tolerant: broken or
// unmatched tags are inert, and their text rolls up to the enclosing level — so the tree view is
// exactly the text the model saw, never a rearrangement. When no tags match at all, it degrades
// to a single collapsed "Complete prompt text" block, exactly as before the tree existed.
// Every other group keeps one item per header/slot/message, each defaulting open — those are
// short enough that reviewing the complete literal text inline is the point.
function PromptGroupSection({ group }: { group: PromptPreviewGroup }) {
  // Same ceil-of-total rule as the panel header's totalEstimatedTokens — sum the chars, then one
  // ceil — so section tokens always add up to exactly the header total (summing per-item ceils
  // would over-report by up to one token per item).
  const totalChars = group.items.reduce((sum, i) => sum + i.chars, 0);
  const sectionTokens = Math.ceil(totalChars / 4);
  // The receipt's $ figure (docs/plans/completed/prompt-inspector-usage-cost.md) — undefined when there's
  // no usage (no receipt at all), or when any tier the arithmetic needs is unconfigured (a
  // partial price omits the $ rather than pricing a tier at another tier's rate — silently
  // pricing cache-hit tokens at the miss rate would understate savings, not just omit them).
  const receiptCost = group.usage && group.price ? computeReceiptCost(group.usage, group.price) : undefined;
  return (
    <section className="prompt-inspector-section">
      <h3 className="prompt-inspector-section-title">
        <span>{group.title}</span>
        {group.captured && (
          <span className="prompt-inspector-captured" title="Actual text sent to the model during a turn">
            fired
          </span>
        )}
        {group.items.length > 0 && <span className="prompt-inspector-section-tokens">{sectionTokens.toLocaleString()} tk</span>}
      </h3>
      {group.usage && (
        // Per-call usage receipt (vendor-reported tokens, not the char-count estimate above):
        // prompt tokens split into cache-hit/miss when the vendor reported a cache-read count,
        // plain otherwise; completion; total; and the $ figure only when every tier the
        // arithmetic needs is configured. Absent entirely on the live-reconstruction fallback
        // or a failed turn (no real call to report).
        <div className="prompt-inspector-receipt">
          {group.usage.cacheReadTokens !== undefined ? (
            <span className="prompt-inspector-receipt-item">
              prompt {group.usage.promptTokens.toLocaleString()} tk
              <span className="prompt-inspector-receipt-cache">
                {' '}
                ({group.usage.cacheReadTokens.toLocaleString()} hit ·{' '}
                {(group.usage.promptTokens - group.usage.cacheReadTokens).toLocaleString()} miss)
              </span>
            </span>
          ) : (
            <span className="prompt-inspector-receipt-item">prompt {group.usage.promptTokens.toLocaleString()} tk</span>
          )}
          <span className="prompt-inspector-receipt-item">completion {group.usage.completionTokens.toLocaleString()} tk</span>
          <span className="prompt-inspector-receipt-item">total {group.usage.totalTokens.toLocaleString()} tk</span>
          {receiptCost !== undefined && (
            <span className="prompt-inspector-receipt-item prompt-inspector-receipt-cost">{formatUsd(receiptCost)}</span>
          )}
        </div>
      )}
      {group.items.length === 0 && <p className="prompt-inspector-empty">Nothing here.</p>}
      {group.kind === 'main' && group.items.length > 0 ? (
        // The whole main prompt as a tag tree — see MainPromptTree below. The cache-coverage
        // fields (stablePrefixChars/previousCallAt) come from buildPromptPreview's diff of the
        // last fired main against the one before it; and stability (per-subsection identical /
        // seen over the trace window, docs §3.3) — all undefined when fewer than two 'main'
        // calls are on record (the tree then shows no cache badges or stability rows at all).
        <MainPromptTree
          items={group.items}
          stablePrefixChars={group.stablePrefixChars}
          previousCallAt={group.previousCallAt}
          stability={group.stability}
        />
      ) : (
        group.items.map((item, i) => (
          <details key={i} className="prompt-inspector-item" open>
            <summary>
              <span className="prompt-inspector-item-label">{itemLabel(item)}</span>
              <span className={`prompt-inspector-item-role prompt-inspector-item-role-${item.role}`}>{item.role}</span>
              <span className="prompt-inspector-item-tokens">
                {item.estimatedTokens.toLocaleString()} tk
              </span>
            </summary>
            <pre className="prompt-inspector-item-content">{item.content}</pre>
          </details>
        ))
      )}
      {group.reply && (
        // The model's reply to this captured prompt — same collapsible block style as the prompt
        // items above, defaulting open like they do. Labeled "Reply" so it can't be mistaken for
        // a prompt item; its role badge is 'assistant'.
        <details className="prompt-inspector-item" open>
          <summary>
            <span className="prompt-inspector-item-label">Reply</span>
            <span className="prompt-inspector-item-role prompt-inspector-item-role-assistant">assistant</span>
            <span className="prompt-inspector-item-tokens">
              {group.reply.estimatedTokens.toLocaleString()} tk
            </span>
          </summary>
          <pre className="prompt-inspector-item-content">{group.reply.content}</pre>
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main Prompt tag tree (docs/plans/completed/prompt-inspector-tag-tree.md)
// ---------------------------------------------------------------------------

// The main prompt's items joined in send order — exactly the text the model saw — parsed into a
// display-only tag tree by orchestrator's util/promptTagTree.ts (pure, exported as
// @bigbrain/orchestrator/prompt-tag-tree). No tags matched → the same single collapsed block the
// panel showed before the tree existed. Tags matched → the tree: each section a collapsible row,
// collapsed by default, with its canonical tag name and its own token budget; text that
// belongs to no matched section (untagged preamble, history between tags, broken-tag leftovers)
// rolls up and renders as "untagged text" at the enclosing level — nothing is ever dropped.
function MainPromptTree({
  items,
  stablePrefixChars,
  previousCallAt,
  stability,
}: {
  items: PromptPreviewItem[];
  stablePrefixChars?: number;
  previousCallAt?: number;
  stability?: PromptPreviewGroup['stability'];
}) {
  const text = items.map((i) => i.content).join('\n\n');
  const tree = parsePromptTagTree(text);
  if (tree.children.length === 0) {
    const totalChars = items.reduce((sum, i) => sum + i.chars, 0);
    const sectionTokens = Math.ceil(totalChars / 4);
    return (
      <details className="prompt-inspector-item">
        <summary>
          <span className="prompt-inspector-item-label">Complete prompt text</span>
          <CacheBadge end={text.length} stablePrefixChars={stablePrefixChars} />
          <span className="prompt-inspector-item-tokens">
            {sectionTokens.toLocaleString()} tk
          </span>
        </summary>
        <pre className="prompt-inspector-item-content">{text}</pre>
      </details>
    );
  }
  return (
    <>
      {stablePrefixChars !== undefined && <CacheLegend previousCallAt={previousCallAt} />}
      <PromptTagTreeView
        tree={tree}
        text={text}
        stablePrefixChars={stablePrefixChars}
        stability={stability}
      />
    </>
  );
}

// A section's own text = everything inside its span that no child section owns, with its OWN
// open/close tag bytes also excluded (promptTagTree's contentStart/contentEnd) — for the root
// that's the untagged preamble/trailing text (root has no wrapper tag, contentStart/End === its
// start/end); for a real section it's the text between its open tag and its first child, between
// children, and after its last child, before the close tag. Excluding the section's own tags here
// matters: a section whose entire body is one nested child (e.g. a migration-0086 group wrapping
// a single tagEnabled slot) would otherwise render its own-text block as just the two tag lines
// with nothing between them — indistinguishable from "no content" even though the child, one
// level down, holds the real text. Slicing, never rewriting — walking every section in document
// order (this text, plus each child's own tags + its own text, recursively) reproduces the source
// byte-for-byte.
function ownText(section: PromptTagSection, text: string): string {
  let out = '';
  let cursor = section.contentStart;
  for (const child of section.children) {
    out += text.slice(cursor, child.start);
    cursor = child.end;
  }
  return out + text.slice(cursor, section.contentEnd);
}

// Total content chars for a section, tag bytes included — this is what actually ships to the
// model, so the token budget must count it even though ownText() above (display only) excludes
// it. Sections are disjoint and their spans cover the source exactly, so this is always just
// end - start; no need to walk children to sum it.
function sectionChars(section: PromptTagSection): number {
  return section.end - section.start;
}

// Per-section stability lookup (docs/plans/completed/prompt-inspector-tag-tree.md §3.3): matches the server's
// key rule exactly — canonical tag name, plus #occ when the name repeats, in preorder (a section
// before its children, matching flattenSections' walk). Rendering walks the same order, so a
// shared tracker yields the same keys; each rendered row looks up its stat once.
class SectionStatLookup {
  private occurrence = new Map<string, number>();
  constructor(private readonly stats?: PromptPreviewGroup['stability']) {}
  next(name: string): { seen: number; identical: number; comparisons: number } | undefined {
    if (!this.stats) return undefined;
    const occ = this.occurrence.get(name) ?? 0;
    this.occurrence.set(name, occ + 1);
    const stat = this.stats.sections.find((s) => s.key === (occ === 0 ? name : `${name}#${occ}`));
    return stat ? { seen: stat.seen, identical: stat.identical, comparisons: this.stats.comparisons } : undefined;
  }
}

function PromptTagTreeView({
  tree,
  text,
  stablePrefixChars,
  stability,
}: {
  tree: PromptTagSection;
  text: string;
  stablePrefixChars?: number;
  stability?: PromptPreviewGroup['stability'];
}) {
  const own = ownText(tree, text);
  const hasOwn = own.trim().length > 0;
  const stats = new SectionStatLookup(stability);
  return (
    <div className="prompt-inspector-tree">
      {hasOwn && (
        // Untagged text at the top level (the preset's --- preamble, history between tags, …):
        // rendered as a first-class collapsed block so no part of the sent text is hidden. Its
        // cache badge covers all of its runs: every run must end at or before the stable prefix
        // (the root's own text is rarely one contiguous span — see ownRuns below). No stability
        // row: untagged text has no canonical tag identity to key observations on.
        <details className="prompt-inspector-tag">
          <summary>
            <span className="prompt-inspector-tag-name">untagged text</span>
            <CacheBadge
              end={Math.max(...ownRuns(tree).map(([, e]) => e))}
              stablePrefixChars={stablePrefixChars}
            />
            <span className="prompt-inspector-item-tokens">
              {Math.ceil(own.length / 4).toLocaleString()} tk
            </span>
          </summary>
          <pre className="prompt-inspector-tag-own">{own}</pre>
        </details>
      )}
      <div className="prompt-inspector-tag-children">
        {tree.children.map((child, i) => (
          <PromptTagSectionView key={i} section={child} text={text} stablePrefixChars={stablePrefixChars} stats={stats} />
        ))}
      </div>
    </div>
  );
}

// A section's own text as (start, end) offset runs, in document order — the exact slices
// ownText() concatenates. Used to badge the root's "untagged text" block (which may span several
// disjoint runs: preamble, gaps between sections, trailing text) against the stable prefix.
function ownRuns(section: PromptTagSection): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let cursor = section.start;
  for (const child of section.children) {
    if (child.start > cursor) runs.push([cursor, child.start]);
    cursor = child.end;
  }
  if (section.end > cursor) runs.push([cursor, section.end]);
  return runs;
}

function PromptTagSectionView({
  section,
  text,
  stablePrefixChars,
  stats,
}: {
  section: PromptTagSection;
  text: string;
  stablePrefixChars?: number;
  stats: SectionStatLookup;
}) {
  const own = ownText(section, text);
  const chars = sectionChars(section);
  const tokens = Math.ceil(chars / 4);
  const hasOwn = own.trim().length > 0;
  const hasChildren = section.children.length > 0;
  const stat = stats.next(section.name);
  if (!hasOwn && !hasChildren) {
    // Empty section (<a></a>) — nothing to expand; render as a plain row with its budget.
    return (
      <div className="prompt-inspector-tag prompt-inspector-tag-leaf">
        <span className="prompt-inspector-tag-name">{section.name}</span>
        <CacheBadge end={section.end} stablePrefixChars={stablePrefixChars} />
        <StabilityBadge stat={stat} />
        <span className="prompt-inspector-item-tokens">{tokens.toLocaleString()} tk</span>
      </div>
    );
  }
  return (
    <details className="prompt-inspector-tag">
      <summary>
        <span className="prompt-inspector-tag-name">{section.name}</span>
        <CacheBadge end={section.end} stablePrefixChars={stablePrefixChars} />
        <StabilityBadge stat={stat} />
        {hasChildren && (
          <span className="prompt-inspector-tag-count">
            {section.children.length} section{section.children.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="prompt-inspector-item-tokens">{tokens.toLocaleString()} tk</span>
      </summary>
      {hasOwn && <pre className="prompt-inspector-tag-own">{own}</pre>}
      {hasChildren && (
        <div className="prompt-inspector-tag-children">
          {section.children.map((child, i) => (
            <PromptTagSectionView key={i} section={child} text={text} stablePrefixChars={stablePrefixChars} stats={stats} />
          ))}
        </div>
      )}
    </details>
  );
}

// Cache-coverage badge (docs/plans/completed/prompt-inspector-tag-tree.md §3.2): ⚡ when the section ends at or
// before the stable prefix of the last call vs the one before it — byte-identical upstream of the
// change, so the provider's prefix cache replays it — ✎ when it ends past the prefix (the section
// itself, or something upstream of it, changed: the cache cannot replay past the first differing
// byte). Renders nothing when stablePrefixChars is undefined (fewer than two 'main' calls on
// record — there is nothing to diff against). Icon only, so the tag name and tk count stay
// readable — what the icons mean lives in the tooltip and the legend above the tree.
function CacheBadge({ end, stablePrefixChars }: { end: number; stablePrefixChars?: number }) {
  if (stablePrefixChars === undefined) return null;
  const covered = end <= stablePrefixChars;
  return (
    <span
      className={`prompt-inspector-cache-badge ${covered ? 'prompt-inspector-cache-covered' : 'prompt-inspector-cache-changed'}`}
      title={
        covered
          ? 'Unchanged since the previous call — the provider prefix cache replays this section'
          : 'Changed since the previous call, or downstream of a change — the prefix cache cannot replay it'
      }
    >
      {covered ? '⚡' : '✎'}
    </span>
  );
}

// Per-section stability badge (docs/plans/completed/prompt-inspector-tag-tree.md §3.3): the percentage of the
// trace window's comparisons in which this section was byte-identical to the previous call's
// same section (identical / seen over comparisons pairs). Renders nothing when stability is
// absent (fewer than two 'main' calls on record) or when this rendered section had no
// observation in the window (name never matched a server-side key — e.g. the section is brand
// new this call, outside the window, or the stat list was computed before it existed). Icon+
// label would crowd the row — the pill is just "N%", full explanation on hover (and in the
// legend above the tree).
function StabilityBadge({ stat }: { stat?: { seen: number; identical: number; comparisons: number } }) {
  if (!stat) return null;
  const pct = stat.seen === 0 ? 0 : Math.round((stat.identical / stat.seen) * 100);
  return (
    <span
      className={`prompt-inspector-stability-badge ${pct === 100 ? 'prompt-inspector-stability-stable' : ''}`}
      title={`Byte-identical to the previous call in ${stat.identical} of ${stat.seen} comparisons (window: last ${stat.comparisons} call pairs)`}
    >
      {pct}%
    </span>
  );
}

// One-line legend above the tree, only when the server could diff (stablePrefixChars set): what
// the two badges mean, and which previous call the diff is against (epoch ms → local time).
function CacheLegend({ previousCallAt }: { previousCallAt?: number }) {
  return (
    <div className="prompt-inspector-cache-legend">
      ⚡ cached — byte-identical to the previous call
      {previousCallAt !== undefined && ` (${new Date(previousCallAt).toLocaleString()})`}; ✎ changed —
      edited since, or downstream of an edit. The provider prefix cache replays only the ⚡ run.
    </div>
  );
}
