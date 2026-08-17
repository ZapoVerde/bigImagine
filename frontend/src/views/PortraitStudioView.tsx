import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  createPortraitEntity,
  deletePortraitEntity,
  deletePortraitWikiEntry,
  generatePortraitCandidates,
  getPortraitLayerManifest,
  listPortraitEntities,
  listPortraitWikiEntries,
  setPortraitLayerManifest,
  submitPortraitFeedback,
  updatePortraitEntity,
  updatePortraitWikiEntry,
} from '../api/client';
import type {
  PortraitCandidate,
  PortraitEntityRow,
  PortraitLayerDefinition,
  PortraitLayerManifest,
  PortraitWikiEntry,
} from '../api/types';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import PortraitCandidateGrid from '../components/portraits/PortraitCandidateGrid';
import './PortraitStudioView.css';

// Portrait Studio (docs/plans/completed/portrait-studio-plan.md §Frontend) — the training/authoring surface
// for character portraits: per-layer entity pickers + create-new drive a Generate action; the
// round's candidates land in PortraitCandidateGrid for winner-pick + 1-5 rating + note; feedback
// runs the Reflection Investigation and surfaces an "Applied" banner (created vs amended,
// distinguished); a Wiki panel lists/edits/deletes the reflection's lessons; per-entity
// standing_instructions editing uses the same textarea+Save pattern; Manage Layers (admin-gated —
// visual_layer_stack is a settings write, per the plan's auth note) edits the manifest with the
// subject layer locked and in-use layers unremovable. All portrait reads/writes are user-scoped
// (apiKey); only the layers write takes the admin key. Per portrait-studio-standalone-subjects-
// plan.md, every entity is standalone — never linked to a character — and a bare subject name
// created without standing instructions gets them described from the new optional seed by the
// server's portrait_subject_describer_prompt (Settings tab).
interface PortraitStudioViewProps {
  apiKey: string | null;
}

interface CreateDraft {
  name: string;
  seed: string;
  template: string;
}

const EMPTY_CREATE: CreateDraft = { name: '', seed: '', template: '' };

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function PortraitStudioView({ apiKey }: PortraitStudioViewProps) {
  const [manifest, setManifest] = useState<PortraitLayerManifest | null>(null);
  const [entities, setEntities] = useState<PortraitEntityRow[] | null>(null);
  const [wiki, setWiki] = useState<PortraitWikiEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-layer entity selection driving Generate.
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [creatingLayer, setCreatingLayer] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);

  const [goal, setGoal] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PortraitCandidate[] | null>(null);
  const [roundGoal, setRoundGoal] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ action: 'created' | 'amended'; entryId: string } | null>(null);

  // Per-entity standing_instructions editor.
  const [siEntityId, setSiEntityId] = useState<string | null>(null);
  const [siDraft, setSiDraft] = useState('');
  const [siSaving, setSiSaving] = useState(false);
  const [siSaved, setSiSaved] = useState(false);
  const [siError, setSiError] = useState<string | null>(null);

  // Wiki panel editor.
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [wikiDraft, setWikiDraft] = useState<{ title: string; body: string; tags: string }>({ title: '', body: '', tags: '' });
  const [wikiSaving, setWikiSaving] = useState(false);
  const [wikiError, setWikiError] = useState<string | null>(null);

  // Manage Layers (admin-gated). The manifest read is user-scoped, so the unlock probe is the
  // user-scoped GET; the save goes through the admin key.
  const {
    adminKey,
    setAdminKey,
    checking: layersChecking,
    unlocked: layersUnlocked,
    loadError: layersLoadError,
    load: layersLoad,
  } = useAdminUnlock(async (key) => {
    try {
      await getPortraitLayerManifest(key);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err };
    }
  });
  const [layersDraft, setLayersDraft] = useState<{ layers: PortraitLayerDefinition[]; template: string } | null>(null);
  const [layersSaving, setLayersSaving] = useState(false);
  const [layersSaved, setLayersSaved] = useState(false);
  const [layersSaveError, setLayersSaveError] = useState<string | null>(null);
  const [newLayer, setNewLayer] = useState({ id: '', label: '', boundary: '', promptable: true });

  const refreshEntities = useCallback(async () => {
    try {
      setEntities(await listPortraitEntities(apiKey));
    } catch (err) {
      setLoadError(errMessage(err, 'failed to reload entities'));
    }
  }, [apiKey]);

  const refreshWiki = useCallback(async () => {
    try {
      setWiki(await listPortraitWikiEntries(apiKey));
    } catch (err) {
      setLoadError(errMessage(err, 'failed to reload wiki'));
    }
  }, [apiKey]);

  useEffect(() => {
    (async () => {
      try {
        const [m, es, ws] = await Promise.all([
          getPortraitLayerManifest(apiKey),
          listPortraitEntities(apiKey),
          listPortraitWikiEntries(apiKey),
        ]);
        setManifest(m);
        setEntities(es);
        setWiki(ws);
        const sel: Record<string, string> = {};
        for (const layer of m.layers) {
          if (!layer.promptable) continue;
          const first = es.find((e) => e.layer_id === layer.id);
          if (first) sel[layer.id] = first.entity_id;
        }
        setSelections(sel);
      } catch (err) {
        setLoadError(errMessage(err, 'failed to load Portrait Studio'));
      }
    })();
  }, [apiKey]);

  useEffect(() => {
    if (manifest && !layersDraft) {
      setLayersDraft({ layers: manifest.layers.map((l) => ({ ...l })), template: manifest.template });
    }
  }, [manifest, layersDraft]);

  const promptableLayers = useMemo(() => manifest?.layers.filter((l) => l.promptable) ?? [], [manifest]);
  const inUseLayerIds = useMemo(() => new Set((entities ?? []).map((e) => e.layer_id)), [entities]);

  const focusEntity = entities?.find((e) => e.entity_id === siEntityId) ?? null;

  function startCreate(layerId: string) {
    setCreatingLayer((cur) => (cur === layerId ? null : layerId));
    setCreateDraft(EMPTY_CREATE);
  }

  async function saveNewEntity(layer: PortraitLayerDefinition) {
    if (!createDraft.name.trim()) {
      setGenerateError(`name the new ${layer.label} entity`);
      return;
    }
    try {
      const created = await createPortraitEntity(
        {
          layerId: layer.id,
          name: createDraft.name.trim(),
          ...(layer.id === 'subject' && createDraft.seed.trim() ? { seed: createDraft.seed.trim() } : {}),
          ...(layer.id === 'style' && createDraft.template.trim() ? { template: createDraft.template.trim() } : {}),
        },
        apiKey,
      );
      await refreshEntities();
      setSelections((s) => ({ ...s, [layer.id]: created.entity_id }));
      setCreatingLayer(null);
      setCreateDraft(EMPTY_CREATE);
      setGenerateError(null);
    } catch (err) {
      setGenerateError(errMessage(err, 'failed to create entity'));
    }
  }

  async function deleteEntity(entity: PortraitEntityRow) {
    if (!window.confirm(`Delete "${entity.name}"? This can't be undone.`)) return;
    try {
      await deletePortraitEntity(entity.entity_id, apiKey);
      setSelections((s) => {
        if (s[entity.layer_id] !== entity.entity_id) return s;
        const next = { ...s };
        delete next[entity.layer_id];
        return next;
      });
      if (siEntityId === entity.entity_id) setSiEntityId(null);
      await refreshEntities();
    } catch (err) {
      setGenerateError(errMessage(err, 'failed to delete entity'));
    }
  }

  async function generate() {
    const missing = promptableLayers.filter((l) => !selections[l.id]);
    if (missing.length > 0) {
      setGenerateError(`pick an entity for: ${missing.map((l) => l.label).join(', ')}`);
      return;
    }
    if (!goal.trim()) {
      setGenerateError('describe the round goal');
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    setCandidates(null);
    setSubmitted(false);
    setBanner(null);
    setFeedbackError(null);
    try {
      const cs = await generatePortraitCandidates({ entityIds: selections, goal: goal.trim() }, apiKey);
      setCandidates(cs.filter((c) => c.imageUrl)); // failed renders are omitted from the grid (row still written)
      setRoundGoal(goal.trim());
    } catch (err) {
      setGenerateError(errMessage(err, 'generation failed'));
    } finally {
      setGenerating(false);
    }
  }

  async function pickWinner(candidateId: string, ratings: Record<string, number>, notes: Record<string, string>) {
    if (!candidates || candidates.length === 0) return;
    setSubmitting(true);
    setFeedbackError(null);
    setBanner(null);
    try {
      const res = await submitPortraitFeedback(
        {
          entityIds: selections,
          goal: roundGoal,
          candidateIds: candidates.map((c) => c.candidateId),
          winnerId: candidateId,
          ratings,
          notes,
        },
        apiKey,
      );
      if (res.reflection?.action === 'created' || res.reflection?.action === 'amended') {
        setBanner({ action: res.reflection.action, entryId: res.reflection.entryId ?? '' });
      }
      setSubmitted(true);
      void refreshEntities();
      void refreshWiki();
    } catch (err) {
      setFeedbackError(errMessage(err, 'feedback failed'));
    } finally {
      setSubmitting(false);
    }
  }

  function openSi(entity: PortraitEntityRow) {
    setSiEntityId(entity.entity_id);
    setSiDraft(entity.standing_instructions ?? '');
    setSiSaved(false);
    setSiError(null);
  }

  async function saveStandingInstructions() {
    if (!focusEntity) return;
    setSiSaving(true);
    setSiError(null);
    try {
      await updatePortraitEntity(focusEntity.entity_id, { standingInstructions: siDraft }, apiKey);
      setSiSaved(true);
      await refreshEntities();
    } catch (err) {
      setSiError(errMessage(err, 'failed to save standing instructions'));
    } finally {
      setSiSaving(false);
    }
  }

  function openWikiEditor(entry: PortraitWikiEntry) {
    setEditingEntryId(entry.entry_id);
    setWikiDraft({ title: entry.title, body: entry.body, tags: entry.tags.join(', ') });
    setWikiError(null);
  }

  async function saveWikiEntry() {
    if (!editingEntryId) return;
    setWikiSaving(true);
    setWikiError(null);
    try {
      await updatePortraitWikiEntry(
        editingEntryId,
        {
          title: wikiDraft.title.trim(),
          body: wikiDraft.body,
          tags: wikiDraft.tags.split(',').map((t) => t.trim()).filter(Boolean),
        },
        apiKey,
      );
      setEditingEntryId(null);
      await refreshWiki();
    } catch (err) {
      setWikiError(errMessage(err, 'failed to save wiki entry'));
    } finally {
      setWikiSaving(false);
    }
  }

  async function deleteWikiEntry(entry: PortraitWikiEntry) {
    if (!window.confirm(`Delete wiki entry "${entry.title}"? This can't be undone.`)) return;
    try {
      await deletePortraitWikiEntry(entry.entry_id, apiKey);
      if (editingEntryId === entry.entry_id) setEditingEntryId(null);
      await refreshWiki();
    } catch (err) {
      setWikiError(errMessage(err, 'failed to delete wiki entry'));
    }
  }

  function patchLayers(layerId: string, patch: Partial<PortraitLayerDefinition>) {
    setLayersDraft((d) => (d ? { ...d, layers: d.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)) } : d));
  }

  function removeLayer(layerId: string, label: string) {
    if (!window.confirm(`Remove layer "${label}"? This can't be undone once you save the manifest.`)) return;
    setLayersDraft((d) => (d ? { ...d, layers: d.layers.filter((l) => l.id !== layerId) } : d));
  }

  function addLayer() {
    if (!layersDraft) return;
    if (!newLayer.id.trim() || !newLayer.label.trim() || !newLayer.boundary.trim()) return;
    if (layersDraft.layers.some((l) => l.id === newLayer.id.trim())) return;
    setLayersDraft((d) =>
      d
        ? {
            ...d,
            layers: [...d.layers, { id: newLayer.id.trim(), label: newLayer.label.trim(), boundary: newLayer.boundary.trim(), promptable: newLayer.promptable }],
          }
        : d,
    );
    setNewLayer({ id: '', label: '', boundary: '', promptable: true });
  }

  async function saveLayers() {
    if (!layersDraft) return;
    if (!layersDraft.layers.some((l) => l.id === 'subject')) {
      setLayersSaveError('the subject layer cannot be removed');
      return;
    }
    setLayersSaving(true);
    setLayersSaveError(null);
    try {
      await setPortraitLayerManifest(layersDraft, adminKey);
      setManifest(await getPortraitLayerManifest(apiKey));
      setLayersSaved(true);
      window.setTimeout(() => setLayersSaved(false), 2000);
    } catch (err) {
      setLayersSaveError(errMessage(err, 'failed to save layer manifest'));
    } finally {
      setLayersSaving(false);
    }
  }

  if (loadError) {
    return <div className="error-banner">{loadError}</div>;
  }
  if (!manifest || !entities || !wiki) {
    return <div className="portrait-studio-view loading">Loading Portrait Studio…</div>;
  }

  return (
    <div className="portrait-studio-view">
      <header className="portrait-studio-header">
        <h2>Portrait Studio</h2>
        <p className="portrait-studio-sub">Train and evaluate character portraits — the loop that writes the wiki future rounds read.</p>
      </header>

      {/* Entity pickers per promptable layer, following ConnectionsView's select pattern. */}
      <section className="portrait-pickers">
        {promptableLayers.map((layer) => {
          const layerEntities = entities.filter((e) => e.layer_id === layer.id);
          return (
            <div key={layer.id} className="portrait-picker">
              <label className="portrait-picker-label">
                {layer.label} <span className="portrait-picker-id">({layer.id})</span>
              </label>
              <div className="portrait-picker-row">
                <select value={selections[layer.id] ?? ''} onChange={(e) => setSelections((s) => ({ ...s, [layer.id]: e.target.value }))}>
                  <option value="">— none —</option>
                  {layerEntities.map((e) => (
                    <option key={e.entity_id} value={e.entity_id}>
                      {e.name}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => startCreate(layer.id)}>
                  {creatingLayer === layer.id ? 'cancel' : '+ new'}
                </button>
                <button
                  type="button"
                  className="portrait-wiki-delete"
                  disabled={!selections[layer.id]}
                  title={!selections[layer.id] ? 'pick an entity to delete' : undefined}
                  onClick={() => {
                    const entity = layerEntities.find((e) => e.entity_id === selections[layer.id]);
                    if (entity) void deleteEntity(entity);
                  }}
                >
                  delete
                </button>
              </div>
              {creatingLayer === layer.id && (
                <div className="portrait-create">
                  <input value={createDraft.name} onChange={(e) => setCreateDraft((d) => ({ ...d, name: e.target.value }))} placeholder={`New ${layer.label} name`} />
                  {layer.id === 'subject' && (
                    <input value={createDraft.seed} onChange={(e) => setCreateDraft((d) => ({ ...d, seed: e.target.value }))} placeholder="Seed (optional) — e.g. an Italian woman in her 30s" />
                  )}
                  {layer.id === 'style' && (
                    <textarea rows={2} value={createDraft.template} onChange={(e) => setCreateDraft((d) => ({ ...d, template: e.target.value }))} placeholder="Composed-prompt template (optional, e.g. {{subject_overflow}} — {{style_overflow}})" />
                  )}
                  <button type="button" onClick={() => saveNewEntity(layer)}>
                    Create
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* Generate. */}
      <section className="portrait-generate">
        <label>
          Round goal
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. A calmer evening variant of Rin at the teahouse" />
        </label>
        <button type="button" onClick={generate} disabled={generating}>
          {generating ? 'Generating…' : 'Generate candidates'}
        </button>
        {generateError && <div className="error-banner">{generateError}</div>}
      </section>

      {/* The round's candidates. */}
      {candidates && candidates.length > 0 && (
        <PortraitCandidateGrid candidates={candidates} goal={roundGoal} submitted={submitted} onPickWinner={pickWinner} />
      )}
      {submitting && <div className="portrait-submitting">Recording evaluation and running Reflection…</div>}
      {feedbackError && <div className="error-banner">{feedbackError}</div>}
      {banner && (
        <div className="portrait-banner">
          {banner.action === 'created'
            ? `Reflection wrote a new wiki lesson${banner.entryId ? ` (${banner.entryId})` : ''}.`
            : `Reflection amended a wiki lesson${banner.entryId ? ` (${banner.entryId})` : ''}.`}
        </div>
      )}

      {/* Wiki panel — list/edit/delete, same fieldset/textarea/Save convention as Settings. */}
      <section className="portrait-wiki">
        <h3>Wiki</h3>
        {wikiError && <div className="error-banner">{wikiError}</div>}
        {wiki.length === 0 && <div className="portrait-empty">No lessons yet — the first round's Reflection writes the first entry.</div>}
        {wiki.map((entry) => (
          <article key={entry.entry_id} className="portrait-wiki-entry">
            {editingEntryId === entry.entry_id ? (
              <div className="portrait-wiki-edit">
                <input value={wikiDraft.title} onChange={(e) => setWikiDraft((d) => ({ ...d, title: e.target.value }))} placeholder="Title" />
                <textarea rows={4} value={wikiDraft.body} onChange={(e) => setWikiDraft((d) => ({ ...d, body: e.target.value }))} placeholder="Body" />
                <input value={wikiDraft.tags} onChange={(e) => setWikiDraft((d) => ({ ...d, tags: e.target.value }))} placeholder="Tags (comma-separated)" />
                <div className="portrait-wiki-actions">
                  <button type="button" onClick={saveWikiEntry} disabled={wikiSaving || !wikiDraft.title.trim()}>
                    {wikiSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" onClick={() => setEditingEntryId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <header className="portrait-wiki-entry-header">
                  <span className="portrait-wiki-title">{entry.title}</span>
                  <span className="portrait-wiki-tags">{entry.tags.map((t) => `#${t}`).join(' ')}</span>
                  <div className="portrait-wiki-actions">
                    <button type="button" onClick={() => openWikiEditor(entry)}>
                      Edit
                    </button>
                    <button type="button" className="portrait-wiki-delete" onClick={() => deleteWikiEntry(entry)}>
                      Delete
                    </button>
                  </div>
                </header>
                <p className="portrait-wiki-body">{entry.body}</p>
                <footer className="portrait-wiki-meta">
                  {entry.subscriptions.length > 0
                    ? entry.subscriptions
                        .map((s) => {
                          const layer = manifest.layers.find((l) => l.id === s.layerType);
                          const entity = s.layerEntityId ? entities.find((e) => e.entity_id === s.layerEntityId) : null;
                          return entity ? `${layer?.label ?? s.layerType}: ${entity.name}` : `${layer?.label ?? s.layerType}: every entity`;
                        })
                        .join(' · ')
                    : 'unsubscribed'}
                </footer>
              </>
            )}
          </article>
        ))}
      </section>

      {/* Entities — per-entity standing_instructions editing (textarea + Save). */}
      <section className="portrait-entities">
        <h3>Entities</h3>
        <div className="portrait-entity-list">
          {entities.map((entity) => (
            <article key={entity.entity_id} className="portrait-entity-row">
              <header className="portrait-entity-header">
                <span className="portrait-entity-name">{entity.name}</span>
                <span className="portrait-entity-layer">{manifest.layers.find((l) => l.id === entity.layer_id)?.label ?? entity.layer_id}</span>
                {entity.last_image_url && <img className="portrait-entity-thumb" src={entity.last_image_url} alt={`${entity.name} best`} />}
                <button type="button" onClick={() => openSi(entity)}>
                  {siEntityId === entity.entity_id ? 'hide' : 'instructions'}
                </button>
              </header>
              {siEntityId === entity.entity_id && (
                <div className="portrait-si-editor">
                  {siError && <div className="error-banner">{siError}</div>}
                  <textarea rows={3} value={siDraft} onChange={(e) => setSiDraft(e.target.value)} placeholder="Standing instructions — the settled soft concentrate-here hint for this entity" />
                  <div className="portrait-wiki-actions">
                    <button type="button" onClick={saveStandingInstructions} disabled={siSaving}>
                      {siSaving ? 'Saving…' : 'Save'}
                    </button>
                    {siSaved && <span className="portrait-saved-note">Saved.</span>}
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      {/* Manage Layers — admin-gated (settings write). Subject locked; in-use layers unremovable. */}
      <section className="portrait-layers">
        <h3>Manage Layers</h3>
        {layersChecking && <div className="portrait-empty">Checking access…</div>}
        {!layersChecking && !layersUnlocked && (
          <div className="portrait-layers-unlock">
            <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} placeholder="Admin key" />
            <button type="button" onClick={layersLoad}>
              Unlock
            </button>
            {layersLoadError && <div className="error-banner">{layersLoadError}</div>}
          </div>
        )}
        {layersUnlocked && layersDraft && (
          <div className="portrait-layers-editor">
            {layersSaveError && <div className="error-banner">{layersSaveError}</div>}
            <label>
              Prompt template
              <textarea
                rows={3}
                value={layersDraft.template}
                onChange={(e) => setLayersDraft((d) => (d ? { ...d, template: e.target.value } : d))}
                placeholder="e.g. A portrait of {{subject_overflow}}, wearing {{outfit_overflow}}…"
              />
            </label>
            {layersDraft.layers.map((layer) => {
              const isSubject = layer.id === 'subject';
              const inUse = inUseLayerIds.has(layer.id);
              const removable = !isSubject && !inUse;
              return (
                <div key={layer.id} className="portrait-layer-row">
                  <span className="portrait-layer-id">{layer.id}</span>
                  <input value={layer.label} onChange={(e) => patchLayers(layer.id, { label: e.target.value })} />
                  <input value={layer.boundary} onChange={(e) => patchLayers(layer.id, { boundary: e.target.value })} placeholder="Boundary prose" />
                  <label className="portrait-layer-promptable">
                    <input type="checkbox" checked={layer.promptable} onChange={(e) => patchLayers(layer.id, { promptable: e.target.checked })} />
                    promptable
                  </label>
                  <button
                    type="button"
                    className="portrait-wiki-delete"
                    disabled={!removable}
                    title={isSubject ? 'the subject layer cannot be removed' : inUse ? 'entities are still attached to this layer' : undefined}
                    onClick={() => removeLayer(layer.id, layer.label)}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            <div className="portrait-layer-add">
              <input value={newLayer.id} onChange={(e) => setNewLayer((l) => ({ ...l, id: e.target.value }))} placeholder="layer id" />
              <input value={newLayer.label} onChange={(e) => setNewLayer((l) => ({ ...l, label: e.target.value }))} placeholder="label" />
              <input value={newLayer.boundary} onChange={(e) => setNewLayer((l) => ({ ...l, boundary: e.target.value }))} placeholder="boundary" />
              <label className="portrait-layer-promptable">
                <input type="checkbox" checked={newLayer.promptable} onChange={(e) => setNewLayer((l) => ({ ...l, promptable: e.target.checked }))} />
                promptable
              </label>
              <button type="button" onClick={addLayer} disabled={!newLayer.id.trim() || !newLayer.label.trim() || !newLayer.boundary.trim()}>
                Add layer
              </button>
            </div>
            <div className="portrait-wiki-actions">
              <button type="button" onClick={saveLayers} disabled={layersSaving}>
                {layersSaving ? 'Saving…' : 'Save manifest'}
              </button>
              {layersSaved && <span className="portrait-saved-note">Saved.</span>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
