import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  adminActivateImageConnection,
  adminCreateImageConnection,
  adminDeleteImageConnection,
  adminTestImageConnection,
  adminUpdateImageConnection,
} from '../../api/client';
import type { ImageConnectionSummary, ImageConnectionTestResult } from '../../api/types';

// The image-connection editor draft. apiKey is write-only (never round-tripped back); '' means
// "leave the stored key unchanged" when editing, and simply "no key" for keyless providers
// (a local comfyui endpoint) on create. Every other kind — including pollinations, which has
// not been keyless since 2025 (io/imageGen/pollinations.ts throws without a key) — shows the
// field. New connections default to fal.ai's Z-Image-Turbo
// (docs/vistalyze_integration/endpoint.md §2.1) — the 8-step turbo model the upstream VLZ
// extension uses for its falai source/previews.
interface Draft {
  name: string;
  kind: ImageConnectionSummary['kind'];
  model: string;
  apiKey: string;
  baseUrl: string;
  width: string;
  height: string;
  samplingSteps: string;
  cfgScale: string;
  samplerName: string;
  masterPositiveStylePrefix: string;
  masterNegativePrompt: string;
  workflowParameters: string;
}

function emptyDraft(): Draft {
  return {
    name: '',
    kind: 'fal-ai',
    model: 'fal-ai/z-image/turbo',
    apiKey: '',
    baseUrl: '',
    width: '1344',
    height: '768',
    samplingSteps: '30',
    cfgScale: '7',
    samplerName: '',
    masterPositiveStylePrefix: '',
    masterNegativePrompt: '',
    workflowParameters: '',
  };
}

function draftFromConnection(c: ImageConnectionSummary): Draft {
  return {
    name: c.name,
    kind: c.kind,
    model: c.model,
    apiKey: '',
    baseUrl: c.baseUrl ?? '',
    width: String(c.width),
    height: String(c.height),
    samplingSteps: String(c.samplingSteps),
    cfgScale: String(c.cfgScale),
    samplerName: c.samplerName ?? '',
    masterPositiveStylePrefix: c.masterPositiveStylePrefix ?? '',
    masterNegativePrompt: c.masterNegativePrompt ?? '',
    workflowParameters: c.workflowParameters ? JSON.stringify(c.workflowParameters, null, 2) : '',
  };
}

function draftEqualsConnection(draft: Draft, c: ImageConnectionSummary): boolean {
  return (
    draft.name === c.name &&
    draft.kind === c.kind &&
    draft.model === c.model &&
    draft.apiKey === '' &&
    draft.baseUrl === (c.baseUrl ?? '') &&
    draft.width === String(c.width) &&
    draft.height === String(c.height) &&
    draft.samplingSteps === String(c.samplingSteps) &&
    draft.cfgScale === String(c.cfgScale) &&
    draft.samplerName === (c.samplerName ?? '') &&
    draft.masterPositiveStylePrefix === (c.masterPositiveStylePrefix ?? '') &&
    draft.masterNegativePrompt === (c.masterNegativePrompt ?? '') &&
    draft.workflowParameters === (c.workflowParameters ? JSON.stringify(c.workflowParameters, null, 2) : '')
  );
}

function parseWorkflowParameters(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('workflowParameters must be a JSON object (a ComfyUI graph)');
  }
  return parsed as Record<string, unknown>;
}

// The image-generation half of the Connections tab's unified master-detail pane
// (docs/vistalyze_integration/endpoint.md §3) — editor CRUD for admin-managed image backends
// (runware/fal-ai/pollinations/comfyui/openai-images). Owns its draft + save/test/activate/delete;
// the parent ConnectionsView owns the combined list, the text/image toggle, and both per-type
// selections. apiKey stays write-only (hasApiKey is reported, never the value); activation is a
// plain 200 with no restart — the active image connection is resolved live on every generation
// call, so "Set as default" applies on the next render.
interface Props {
  selected: ImageConnectionSummary | null;
  isNew: boolean;
  adminKey: string | null;
  /** Refetch the parent's image list after a save/activate — selectAfter becomes the new selection. */
  onRefresh: (selectAfter?: string) => void;
  /** The parent's list-level reaction to a successful delete (clear selection, close mobile editor, refetch). */
  onDeleted: () => void;
}

export default function ImageConnectionEditor({ selected, isNew, adminKey, onRefresh, onDeleted }: Props) {
  // Always-current selection for async guards — test() below compares the id it probed against
  // the *latest* selection, which the click-time closure cannot see.
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
  }, [selected?.id]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ImageConnectionTestResult | null>(null);

  const [draft, setDraft] = useState<Draft>(emptyDraft());

  useEffect(() => {
    setDraft(selected ? draftFromConnection(selected) : emptyDraft());
    setTestResult(null);
    // Resync whenever a different connection is picked, or its own updatedAt moves (a save just
    // landed) — not on every unrelated connections refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.updatedAt]);

  const dirty = isNew || (selected != null && !draftEqualsConnection(draft, selected));

  async function save() {
    if (!draft.name.trim() || !draft.model.trim()) {
      setError('Name and model are required.');
      return;
    }
    let workflowParameters: Record<string, unknown> | undefined;
    try {
      workflowParameters = parseWorkflowParameters(draft.workflowParameters);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'workflowParameters is not valid JSON');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const created = await adminCreateImageConnection(
          {
            name: draft.name.trim(),
            kind: draft.kind,
            model: draft.model.trim(),
            apiKey: draft.apiKey.trim() || undefined,
            baseUrl: draft.baseUrl.trim() || undefined,
            width: Number(draft.width) || undefined,
            height: Number(draft.height) || undefined,
            samplingSteps: Number(draft.samplingSteps) || undefined,
            cfgScale: Number(draft.cfgScale) || undefined,
            samplerName: draft.samplerName.trim() || undefined,
            masterPositiveStylePrefix: draft.masterPositiveStylePrefix.trim() || undefined,
            masterNegativePrompt: draft.masterNegativePrompt.trim() || undefined,
            workflowParameters,
          },
          adminKey,
        );
        onRefresh(created.id);
      } else if (selected) {
        await adminUpdateImageConnection(
          selected.id,
          {
            name: draft.name.trim(),
            kind: draft.kind,
            model: draft.model.trim(),
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
            baseUrl: draft.baseUrl.trim() || null,
            width: Number(draft.width) || 1344,
            height: Number(draft.height) || 768,
            samplingSteps: Number(draft.samplingSteps) || 30,
            cfgScale: Number(draft.cfgScale) || 7,
            samplerName: draft.samplerName.trim() || null,
            masterPositiveStylePrefix: draft.masterPositiveStylePrefix.trim() || null,
            masterNegativePrompt: draft.masterNegativePrompt.trim() || null,
            workflowParameters: workflowParameters ?? null,
          },
          adminKey,
        );
        onRefresh(selected.id);
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save image connection');
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!selected) return;
    const testedId = selected.id;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await adminTestImageConnection(testedId, adminKey);
      // Guard against a connection switch while the probe is in flight — never show one
      // connection's probe result under another's edit panel. selectedIdRef is the *current*
      // selection (this closure's selectedId is the click-time value and would never differ).
      if (testedId !== selectedIdRef.current) return;
      setTestResult(result);
    } catch (err) {
      if (testedId !== selectedIdRef.current) return;
      setTestResult({ ok: false, latencyMs: 0, error: err instanceof ApiError ? err.message : 'failed to reach the orchestrator' });
    } finally {
      setTesting(false);
    }
  }

  async function activate() {
    if (!selected || selected.isActive) return;
    try {
      await adminActivateImageConnection(selected.id, adminKey);
      onRefresh(selected.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to activate image connection');
    }
  }

  async function removeConnection() {
    if (!selected || selected.isActive) return;
    if (!window.confirm(`Delete image connection "${selected.name}"? This can't be undone.`)) return;
    try {
      await adminDeleteImageConnection(selected.id, adminKey);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete image connection');
    }
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      {!selected && !isNew && <div className="empty-state">Pick an image connection, or create a new one.</div>}

      {(selected || isNew) && (
        <>
          <div className="connections-editor-header">
            <input
              className="connections-name-input"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Connection name"
            />
            {!isNew && selected && (
              <button
                type="button"
                className={`connections-default-btn${selected.isActive ? ' active' : ''}`}
                onClick={activate}
                disabled={selected.isActive}
              >
                {selected.isActive ? 'Active ✓' : 'Set as default'}
              </button>
            )}
            {!isNew && selected && (
              <button
                type="button"
                className="connections-delete-btn"
                onClick={removeConnection}
                disabled={selected.isActive}
                title={selected.isActive ? 'Activate a different connection first' : undefined}
              >
                Delete
              </button>
            )}
          </div>

          <label>
            Kind
            <select
              value={draft.kind}
              onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as Draft['kind'] }))}
            >
              <option value="pollinations">Pollinations</option>
              <option value="runware">Runware</option>
              <option value="fal-ai">fal.ai</option>
              <option value="comfyui">ComfyUI (self-hosted)</option>
              <option value="openai-images">OpenAI / DALL-E</option>
            </select>
          </label>

          <label>
            Model
            <input
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              placeholder={draft.kind === 'pollinations' ? 'e.g. flux' : draft.kind === 'runware' ? 'e.g. runware:100@1' : 'e.g. fal-ai/z-image/turbo'}
            />
          </label>

          <label>
            API key
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              placeholder={isNew ? (draft.kind === 'comfyui' ? 'optional for a local endpoint' : 'required') : 'leave blank to keep the stored key'}
            />
          </label>

          {(draft.kind === 'comfyui' || draft.kind === 'openai-images' || draft.kind === 'fal-ai') && (
            <label>
              Base URL
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                placeholder={draft.kind === 'comfyui' ? 'e.g. http://comfyui:8188' : draft.kind === 'openai-images' ? 'e.g. https://api.openai.com/v1 (default)' : 'e.g. https://queue.fal.run (default)'}
              />
            </label>
          )}

          <label>
            Width
            <input
              type="number"
              min="64"
              max="8192"
              value={draft.width}
              onChange={(e) => setDraft((d) => ({ ...d, width: e.target.value }))}
            />
          </label>

          <label>
            Height
            <input
              type="number"
              min="64"
              max="8192"
              value={draft.height}
              onChange={(e) => setDraft((d) => ({ ...d, height: e.target.value }))}
            />
          </label>

          <label>
            Sampling steps
            <input
              type="number"
              min="1"
              value={draft.samplingSteps}
              onChange={(e) => setDraft((d) => ({ ...d, samplingSteps: e.target.value }))}
            />
          </label>

          <label>
            CFG scale
            <input
              type="number"
              min="0"
              step="0.5"
              value={draft.cfgScale}
              onChange={(e) => setDraft((d) => ({ ...d, cfgScale: e.target.value }))}
            />
          </label>

          <label>
            Sampler name
            <input
              value={draft.samplerName}
              onChange={(e) => setDraft((d) => ({ ...d, samplerName: e.target.value }))}
              placeholder="e.g. euler (optional)"
            />
          </label>

          <label>
            Master positive style prefix
            <textarea
              value={draft.masterPositiveStylePrefix}
              onChange={(e) => setDraft((d) => ({ ...d, masterPositiveStylePrefix: e.target.value }))}
              rows={2}
              placeholder="Prepend to every prompt through this connection (optional)"
            />
          </label>

          <label>
            Master negative prompt
            <textarea
              value={draft.masterNegativePrompt}
              onChange={(e) => setDraft((d) => ({ ...d, masterNegativePrompt: e.target.value }))}
              rows={2}
              placeholder="Negative prompt constraints (optional)"
            />
          </label>

          {draft.kind === 'comfyui' && (
            <label>
              Workflow parameters (ComfyUI graph JSON)
              <textarea
                value={draft.workflowParameters}
                onChange={(e) => setDraft((d) => ({ ...d, workflowParameters: e.target.value }))}
                rows={8}
                placeholder='{ "3": { "class_type": "KSampler", "inputs": {} }, "6": { "class_type": "CLIPTextEncode", "inputs": {} } }'
              />
            </label>
          )}

          <div className="connections-actions">
            <button onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : isNew ? 'Create connection' : 'Save changes'}
            </button>
            {!isNew && (
              <button
                type="button"
                className="connections-test-btn"
                onClick={test}
                disabled={isNew || dirty || testing}
                title={dirty ? 'Save your changes first — Test renders a probe through the saved connection' : undefined}
              >
                {testing ? 'Testing…' : 'Test'}
              </button>
            )}
            {saved && <span className="saved-note">Saved.</span>}
          </div>
          {testResult && (
            <div className="test-step-result">
              {testResult.ok ? (
                <>
                  <img
                    className="test-step-image"
                    src={testResult.imageUrl}
                    alt="Generated probe image"
                  />
                  <div className="test-step-meta">
                    Rendered in {testResult.latencyMs}ms —{' '}
                    <a href={testResult.imageUrl} target="_blank" rel="noreferrer">
                      {testResult.imageUrl}
                    </a>
                  </div>
                </>
              ) : (
                <div className="error-banner">
                  Probe failed after {testResult.latencyMs}ms: {testResult.error}
                </div>
              )}
              {testResult.prompt && (
                <pre className="test-step-prompt">{testResult.prompt}</pre>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
