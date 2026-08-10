/**
 * @file orchestrator/src/util/renderLocationBlock.ts
 * @stamp 2026-08-14
 * @architectural-role Pure Function — the known-locations `<locations>` block renderer
 *   (docs/vistalyze_integration/location.md §5.1)
 * @description
 * Renders the editable known-locations block template (orchestrator_settings
 * `location_injection_prompt`) against the machine-generated location lists. The block is
 * BigImagine's analogue of Triggeryze's lt-update-preset composition
 * (stacks/sillytavern/st-extensions/SillyTavern-Triggeryze/docs/examples/location-tracker.json,
 * lines 289-316): the editable rules text with the two list slots filled from SQL — zero tokens
 * to assemble (bi_principles.md §2: the LLM reasons, nothing else does — and this is a list
 * read, not judgment).
 *
 * Token contract — exactly three tokens are expanded, in one non-recursive pass:
 *   {{parent_locations}}  the newline-joined eligible parent/standalone location names
 *   {{sub_locations}}     the newline-joined eligible sub-location names of the current parent
 *   {{current_parent}}    the split parent of the current scene's active location (or null)
 * Anything else in an override template passes through verbatim (author's responsibility, same
 * as every other injected template — bi_principles.md §18).
 *
 * Omission rules (location.md §5.1) — "omission, not noise":
 *   - empty parents list => the caller must not emit a block at all (loadLocationBlock returns
 *     '' before calling here); this module returns '' defensively if handed an empty list anyway.
 *   - no current parent OR no sub-locations => the lines carrying {{current_parent}} and
 *     {{sub_locations}} are removed entirely (so the built-in template's "… sub-locations:"
 *     header never dangles with an empty list under it).
 *
 * @api-declaration
 * LocationBlockLists — { parents: string[]; subs: string[]; currentParent: string | null }
 * DEFAULT_LOCATION_BLOCK_TEMPLATE — the built-in block (Triggeryze's rules text, adapted)
 * renderLocationBlock(template, lists) -> string — pure; '' when the parents list is empty
 *
 * @contract
 *   assertions:
 *     purity:          pure (deterministic given template + lists — no IO, no state)
 *     state_ownership: []
 *     external_io:     []
 */

export interface LocationBlockLists {
  /** Eligible parent/standalone location names, sorted, deduplicated. */
  parents: string[];
  /** Eligible sub-location names of the current parent, sorted, deduplicated. */
  subs: string[];
  /** The split parent of the current scene's active location, or null (no scene / standalone). */
  currentParent: string | null;
}

/** The built-in block — Triggeryze's lt-update-preset rules text, adapted: the {{lbTitles:…}}
 *  lists become the two tokens, and {{user}} becomes "the user" because the block is emitted
 *  verbatim into the main prompt (the 'location' marker slot is never macro-interpolated). */
export const DEFAULT_LOCATION_BLOCK_TEMPLATE = `<locations>
Known locations:
{{parent_locations}}

{{current_parent}} sub-locations:
{{sub_locations}}

When writing the location header, match against known locations exactly. Use Parent - Sub format. If the location is not listed, create a new one. The location must reflect where the scene ends at the conclusion of the current turn, not where it began. Present should list named characters only, excluding the user and any unnamed or background characters.
</locations>`;

const TOKEN_PATTERN = /\{\{(parent_locations|sub_locations|current_parent)\}\}/g;

export function renderLocationBlock(template: string | undefined, lists: LocationBlockLists): string {
  if (lists.parents.length === 0) return '';
  const tpl = template && template.trim() !== '' ? template : DEFAULT_LOCATION_BLOCK_TEMPLATE;
  let t = tpl;
  if (!lists.currentParent || lists.subs.length === 0) {
    // Strip the sub-section lines entirely rather than leaving an empty "… sub-locations:"
    // header + blank line dangling in the block (location.md §5.1 omission rule). Done on the
    // raw template, BEFORE token expansion — the tokens are what identify the scaffolding
    // lines; once replaced (current_parent → '') they'd be unmatchable.
    t = t.replace(/^[^\n]*\{\{current_parent\}\}[^\n]*\n?/gm, '');
    t = t.replace(/^[^\n]*\{\{sub_locations\}\}[^\n]*\n?/gm, '');
  }
  return t.replace(TOKEN_PATTERN, (_match, name: 'parent_locations' | 'sub_locations' | 'current_parent') => {
    switch (name) {
      case 'parent_locations':
        return lists.parents.join('\n');
      case 'sub_locations':
        return lists.subs.join('\n');
      case 'current_parent':
        return lists.currentParent ?? '';
    }
  });
}
