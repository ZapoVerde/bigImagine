/**
 * @file frontend/src/components/sidebar/PortraitPromptsPanel.tsx
 * @stamp 2026-08-17
 * @architectural-role Stateful Owner (bi_principles.md §8) — owns its own fetch of Portrait
 *   Studio's four background LLM prompts and each one's independent edit/save/revert draft
 * @description
 * Portrait Studio's own sidebar panel (Sidebar.tsx's 'portraits' tab, alongside
 * PortraitConnectionPanel), one stop for every "background" prompt the Studio calls into an LLM
 * with outside the human-visible generation/feedback UI: the subject describer (fires once per
 * entity, at creation — GET/POST /v1/admin/portrait-subject-describer-settings, pre-existing),
 * the slot bootstrapper (fires once per entity, at creation), the mutation/chromosome call (once
 * per generation round), and the reflection/wiki-writing call (once per feedback submission) —
 * the latter three newly surfaced via GET/POST /v1/admin/portrait-background-prompts. Each field
 * is independently editable, saveable, and revertible-to-default (an explicit action, not just
 * clearing the textarea — the server already treats an empty override as "use the built-in
 * default", so Revert is a one-click save of '').
 *
 * Same transparent-admin-key posture as PortraitConnectionPanel: reads the key already stored by
 * a prior Connections/Settings unlock rather than prompting for its own.
 *
 * @api-declaration
 * PortraitPromptsPanel() — no props; entirely self-fetching
 *
 * @contract
 *   assertions:
 *     purity:          impure (fetches, local per-field draft state, per-field optimistic save)
 *     state_ownership: [fields]
 *     external_io:     [adminGetPortraitSubjectDescriberSettings, adminSetPortraitSubjectDescriberSettings,
 *                       adminGetPortraitBackgroundPrompts, adminSetPortraitBackgroundPrompts]
 */

import { useEffect, useState } from 'react';
import { ADMIN_API_KEY_STORAGE_KEY } from '../../api/authStorage';
import {
  adminGetPortraitBackgroundPrompts,
  adminGetPortraitSubjectDescriberSettings,
  adminSetPortraitBackgroundPrompts,
  adminSetPortraitSubjectDescriberSettings,
  ApiError,
} from '../../api/client';
import './PortraitPromptsPanel.css';

type FieldId = 'subjectDescriber' | 'slotBootstrap' | 'mutation' | 'reflection';

interface FieldState {
  label: string;
  description: string;
  draft: string;
  saved: string;
  isDefault: boolean;
  saving: boolean;
  status: string;
}

const FIELD_META: Record<FieldId, { label: string; description: string }> = {
  subjectDescriber: {
    label: 'Subject describer',
    description: 'Turns a bare subject name (+ optional seed) into its standing_instructions, on creation.',
  },
  slotBootstrap: {
    label: 'Slot bootstrap',
    description: 'Invents a fresh entity’s starting slot set from its name + description, on creation.',
  },
  mutation: {
    label: 'Mutation (chromosome)',
    description: 'Proposes each round’s candidate chromosomes from the parent slots + goal.',
  },
  reflection: {
    label: 'Reflection (wiki-writing)',
    description: 'Evaluates a completed round and decides whether to write or amend a wiki lesson.',
  },
};

function initialFields(): Record<FieldId, FieldState> {
  const out = {} as Record<FieldId, FieldState>;
  for (const id of Object.keys(FIELD_META) as FieldId[]) {
    out[id] = { ...FIELD_META[id], draft: '', saved: '', isDefault: true, saving: false, status: '' };
  }
  return out;
}

export default function PortraitPromptsPanel() {
  const [fields, setFields] = useState<Record<FieldId, FieldState>>(initialFields);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    Promise.all([adminGetPortraitSubjectDescriberSettings(adminKey), adminGetPortraitBackgroundPrompts(adminKey)])
      .then(([describer, background]) => {
        setFields((f) => ({
          ...f,
          subjectDescriber: { ...f.subjectDescriber, draft: describer.describerPrompt, saved: describer.describerPrompt, isDefault: describer.describerPromptIsDefault },
          slotBootstrap: { ...f.slotBootstrap, draft: background.slotBootstrapPrompt, saved: background.slotBootstrapPrompt, isDefault: background.slotBootstrapPromptIsDefault },
          mutation: { ...f.mutation, draft: background.mutationPrompt, saved: background.mutationPrompt, isDefault: background.mutationPromptIsDefault },
          reflection: { ...f.reflection, draft: background.reflectionPrompt, saved: background.reflectionPrompt, isDefault: background.reflectionPromptIsDefault },
        }));
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'failed to load prompts'))
      .finally(() => setLoading(false));
  }, []);

  function setDraft(id: FieldId, draft: string) {
    setFields((f) => ({ ...f, [id]: { ...f[id], draft } }));
  }

  async function save(id: FieldId, text: string) {
    setFields((f) => ({ ...f, [id]: { ...f[id], saving: true, status: '' } }));
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    try {
      if (id === 'subjectDescriber') {
        const result = await adminSetPortraitSubjectDescriberSettings({ describer_prompt: text }, adminKey);
        setFields((f) => ({
          ...f,
          subjectDescriber: { ...f.subjectDescriber, draft: result.describerPrompt, saved: result.describerPrompt, isDefault: result.describerPromptIsDefault, saving: false, status: 'Saved.' },
        }));
        return;
      }
      const patchKey = id === 'slotBootstrap' ? 'slot_bootstrap_prompt' : id === 'mutation' ? 'mutation_prompt' : 'reflection_prompt';
      const result = await adminSetPortraitBackgroundPrompts({ [patchKey]: text }, adminKey);
      const [promptField, isDefaultField]: [keyof typeof result, keyof typeof result] =
        id === 'slotBootstrap'
          ? ['slotBootstrapPrompt', 'slotBootstrapPromptIsDefault']
          : id === 'mutation'
            ? ['mutationPrompt', 'mutationPromptIsDefault']
            : ['reflectionPrompt', 'reflectionPromptIsDefault'];
      setFields((f) => ({
        ...f,
        [id]: { ...f[id], draft: result[promptField] as string, saved: result[promptField] as string, isDefault: result[isDefaultField] as boolean, saving: false, status: 'Saved.' },
      }));
    } catch (err) {
      setFields((f) => ({ ...f, [id]: { ...f[id], saving: false, status: err instanceof ApiError ? err.message : 'Couldn’t save — check the admin key (Connections tab).' } }));
    }
  }

  if (loading) return <div className="portrait-prompts-panel empty-state small">Loading…</div>;
  if (loadError) return <div className="portrait-prompts-panel error-banner">{loadError}</div>;

  return (
    <div className="portrait-prompts-panel">
      {(Object.keys(FIELD_META) as FieldId[]).map((id) => {
        const field = fields[id];
        const dirty = field.draft !== field.saved;
        return (
          <details key={id} className="portrait-prompt-field">
            <summary>
              {field.label} {field.isDefault && <em>(default)</em>}
            </summary>
            <p className="portrait-prompt-description">{field.description}</p>
            <textarea rows={8} value={field.draft} onChange={(e) => setDraft(id, e.target.value)} disabled={field.saving} />
            <div className="portrait-prompt-actions">
              <button type="button" onClick={() => save(id, field.draft)} disabled={field.saving || !dirty}>
                {field.saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={() => save(id, '')} disabled={field.saving || field.isDefault}>
                Revert to default
              </button>
            </div>
            {field.status && <div className="portrait-prompt-status">{field.status}</div>}
          </details>
        );
      })}
    </div>
  );
}
