// plugins/context-stack-presets' marker vocabulary (docs/spec.md §7.4) — deliberately mirrors the
// V2/V3 character-card field names plus BI's narrative additions, in the same order the shipped
// "Standard" builtin assembles them. Shared by PromptStacksView.tsx (the preset editor) and
// PromptInspectorPanel.tsx (the per-turn prompt breakdown) so a marker's display name never drifts
// between the two surfaces.
export const MARKER_LABELS: Record<string, string> = {
  system: 'System Prompt',
  global_rules: 'Global Rules',
  description: 'Description',
  personality: 'Personality',
  scenario: 'Scenario',
  persona: 'User Persona',
  location: 'Active Location',
  canon_facts: 'Canon Facts',
  mes_example: 'Example Messages',
  memory_recall: 'Memory Recall',
  recent_history: 'Recent History',
  post_history_instructions: 'Post-History Instructions',
};

export const MARKER_KEYS = Object.keys(MARKER_LABELS);

export function markerLabel(key: string): string {
  return MARKER_LABELS[key] ?? key;
}
