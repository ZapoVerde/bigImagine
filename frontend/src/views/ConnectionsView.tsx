import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  adminActivateConnection,
  adminCreateConnection,
  adminDeleteConnection,
  adminListConnectionModels,
  adminListConnectionProviders,
  adminListConnections,
  adminTestConnection,
  adminUpdateConnection,
} from '../api/client';
import { formatPricePerMillion } from '../api/pricing';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import type { ConnectionTestResult, LlmConnectionSummary } from '../api/types';
import './ConnectionsView.css';

const NEW_ID = 'new';

// keySource: '' means "leave the stored key unchanged" (edit only — never valid for a new
// connection), 'new' means "use the apiKey field below", anything else is another connection's id
// whose key to reuse (LlmConnectionInit/Patch.copyApiKeyFrom) — the escape hatch for several named
// connections that share one underlying provider (e.g. three OpenRouter connections, one model
// each) without re-pasting the same key into every one of them.
interface Draft {
  name: string;
  kind: 'anthropic' | 'openai-compatible';
  model: string;
  apiKey: string;
  keySource: string;
  baseUrl: string;
  supportsVision: boolean;
  providerPrimary: string;
  providerFallback: string;
  allowFallbacks: boolean;
  quantizations: string;
}

function emptyDraft(): Draft {
  return {
    name: '',
    kind: 'openai-compatible',
    model: '',
    apiKey: '',
    keySource: 'new',
    baseUrl: '',
    supportsVision: false,
    providerPrimary: '',
    providerFallback: '',
    allowFallbacks: true,
    quantizations: '',
  };
}

function draftFromConnection(c: LlmConnectionSummary): Draft {
  return {
    name: c.name,
    kind: c.kind,
    model: c.model,
    apiKey: '',
    keySource: '',
    baseUrl: c.baseUrl ?? '',
    supportsVision: c.supportsVision,
    providerPrimary: c.providerOrder?.[0] ?? '',
    providerFallback: c.providerOrder?.[1] ?? '',
    allowFallbacks: c.allowFallbacks,
    quantizations: (c.quantizations ?? []).join(', '),
  };
}

function draftEqualsConnection(draft: Draft, c: LlmConnectionSummary): boolean {
  return (
    draft.name === c.name &&
    draft.kind === c.kind &&
    draft.model === c.model &&
    draft.keySource === '' &&
    draft.baseUrl === (c.baseUrl ?? '') &&
    draft.supportsVision === c.supportsVision &&
    draft.providerPrimary === (c.providerOrder?.[0] ?? '') &&
    draft.providerFallback === (c.providerOrder?.[1] ?? '') &&
    draft.allowFallbacks === c.allowFallbacks &&
    draft.quantizations === (c.quantizations ?? []).join(', ')
  );
}

function parseQuantizations(raw: string): string[] | undefined {
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function providerOrderFromDraft(draft: Draft): string[] | undefined {
  const order = [draft.providerPrimary, draft.providerFallback].filter(Boolean);
  return order.length > 0 ? order : undefined;
}

// Named, admin-managed LLM connections (io/llmConnections.ts, db/migrations/0062_llm_connections.sql)
// — replaces the old Settings-tab "Connection" fieldset, which could only pick among profiles
// hardcoded in BIGBRAIN_LLM_PROFILES. Same master-detail CRUD shape as PromptStacksView.tsx: a left
// list, a right editor pane, edits staged in local draft state and committed on Save. Provider
// pinning (primary + optional fallback provider, allow_fallbacks toggle, quantization filter) is
// OpenRouter's own per-request `provider` object — pin routing instead of hitting its whole default
// set, only offered for kind 'openai-compatible' (Anthropic has no such catalog).
export default function ConnectionsView() {
  const [connections, setConnections] = useState<LlmConnectionSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateStatus, setActivateStatus] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [mobileShowEditor, setMobileShowEditor] = useState(false);

  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [modelOptions, setModelOptions] = useState<{ id: string; pricing?: { prompt: string; completion: string } }[]>([]);
  const [modelsError, setModelsError] = useState('');
  const [providerOptions, setProviderOptions] = useState<{ name: string; tag: string; pricing?: { prompt: string; completion: string } }[]>(
    [],
  );
  const [providersError, setProvidersError] = useState('');

  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const result = await adminListConnections(key);
      setConnections(result);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

  const refresh = useCallback(
    async (selectAfter?: string) => {
      try {
        const result = await adminListConnections(adminKey);
        setConnections(result);
        setError(null);
        if (selectAfter) setSelectedId(selectAfter);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to load connections');
      }
    },
    [adminKey],
  );

  const selected = connections?.find((c) => c.id === selectedId) ?? null;
  const isNew = selectedId === NEW_ID;

  useEffect(() => {
    setDraft(selected ? draftFromConnection(selected) : emptyDraft());
    setModelOptions([]);
    setModelsError('');
    setProviderOptions([]);
    setProvidersError('');
    setTestResult(null);
    // Resync whenever a different connection is picked, or its own updatedAt moves (a save just
    // landed) — not on every unrelated connections refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.updatedAt]);

  // Model catalog preview needs a saved connection's own id (the backend builds a throwaway
  // provider around whatever resolveById returns) — unavailable for an in-progress 'new' draft.
  useEffect(() => {
    if (!selected || isNew) return;
    let cancelled = false;
    setModelsError('');
    adminListConnectionModels(selected.id, adminKey)
      .then((result) => {
        if (!cancelled) setModelOptions(result.models);
      })
      .catch((err) => {
        if (!cancelled) setModelsError(err instanceof ApiError ? err.message : 'failed to list models for this connection');
      });
    return () => {
      cancelled = true;
    };
  }, [selected, isNew, adminKey]);

  // OpenRouter's own per-model provider routing table — 404 for any non-OpenRouter connection just
  // means "nothing to pin routing to", not a real error; only a genuine fetch failure shows the
  // error banner. Refetches whenever the draft's own model field changes, so the picker previews
  // routing for whatever model is about to be saved, not necessarily the stored one.
  useEffect(() => {
    if (!selected || isNew || draft.kind !== 'openai-compatible' || !draft.model) {
      setProviderOptions([]);
      return;
    }
    let cancelled = false;
    setProvidersError('');
    adminListConnectionProviders(selected.id, draft.model, adminKey)
      .then((result) => {
        if (!cancelled) setProviderOptions(result.providers);
      })
      .catch((err) => {
        if (cancelled) return;
        setProviderOptions([]);
        if (err instanceof ApiError && err.status === 404) return;
        setProvidersError(err instanceof ApiError ? err.message : 'failed to list providers for this model');
      });
    return () => {
      cancelled = true;
    };
  }, [selected, isNew, draft.kind, draft.model, adminKey]);

  function createNew() {
    setSelectedId(NEW_ID);
    setDraft(emptyDraft());
    setMobileShowEditor(true);
  }

  function selectConnection(id: string) {
    setSelectedId(id);
    setMobileShowEditor(true);
  }

  const dirty = isNew || (selected != null && !draftEqualsConnection(draft, selected));

  async function save() {
    if (!draft.name.trim() || !draft.model.trim()) {
      setError('Name and model are required.');
      return;
    }
    if (draft.kind === 'openai-compatible' && !draft.baseUrl.trim()) {
      setError('Base URL is required for an OpenAI-compatible connection.');
      return;
    }
    if (draft.keySource === 'new' && !draft.apiKey.trim()) {
      setError('An API key is required, or pick an existing connection to reuse its key.');
      return;
    }
    if (isNew && !draft.keySource) {
      setError('Pick an API key source: a new key, or reuse an existing connection’s.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const created = await adminCreateConnection(
          {
            name: draft.name.trim(),
            kind: draft.kind,
            model: draft.model.trim(),
            apiKey: draft.keySource === 'new' ? draft.apiKey : undefined,
            copyApiKeyFrom: draft.keySource === 'new' ? undefined : draft.keySource,
            baseUrl: draft.kind === 'openai-compatible' ? draft.baseUrl.trim() : draft.baseUrl.trim() || undefined,
            supportsVision: draft.supportsVision,
            providerOrder: providerOrderFromDraft(draft),
            allowFallbacks: draft.allowFallbacks,
            quantizations: parseQuantizations(draft.quantizations),
          },
          adminKey,
        );
        await refresh(created.id);
      } else if (selected) {
        await adminUpdateConnection(
          selected.id,
          {
            name: draft.name.trim(),
            model: draft.model.trim(),
            ...(draft.keySource === 'new' && draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
            ...(draft.keySource && draft.keySource !== 'new' ? { copyApiKeyFrom: draft.keySource } : {}),
            baseUrl: draft.baseUrl.trim() || null,
            supportsVision: draft.supportsVision,
            providerOrder: providerOrderFromDraft(draft) ?? null,
            allowFallbacks: draft.allowFallbacks,
            quantizations: parseQuantizations(draft.quantizations) ?? null,
          },
          adminKey,
        );
        await refresh(selected.id);
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save connection');
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!selected) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await adminTestConnection(selected.id, adminKey));
    } catch (err) {
      setTestResult({ ok: false, latencyMs: 0, error: err instanceof ApiError ? err.message : 'failed to reach the orchestrator' });
    } finally {
      setTesting(false);
    }
  }

  async function activate() {
    if (!selected || selected.isActive) return;
    setActivating(true);
    setActivateStatus('');
    try {
      await adminActivateConnection(selected.id, adminKey);
    } catch (err) {
      setActivateStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to activate');
      setActivating(false);
      return;
    }
    setActivateStatus('Saved. The orchestrator is restarting — this will take a few seconds.');
    const poll = window.setInterval(async () => {
      try {
        const res = await fetch('/healthz');
        if (res.ok) {
          clearInterval(poll);
          setActivating(false);
          setActivateStatus('Back up — reload to confirm.');
          await refresh(selected.id);
        }
      } catch {
        // still restarting, keep polling
      }
    }, 2000);
  }

  async function removeConnection() {
    if (!selected || selected.isActive) return;
    if (!window.confirm(`Delete "${selected.name}"? This can't be undone.`)) return;
    try {
      await adminDeleteConnection(selected.id, adminKey);
      setSelectedId(null);
      setMobileShowEditor(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete connection');
    }
  }

  if (checking) {
    return <div className="connections-view" />;
  }

  if (!unlocked) {
    return (
      <div className="connections-view">
        <h1>BigImagine — connections</h1>
        <label>
          Admin API key
          <br />
          <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
        </label>
        <br />
        <button onClick={load}>Load</button>
        {loadError && <div className="error-banner">{loadError}</div>}
      </div>
    );
  }

  if (connections === null) {
    return <div className="connections-view loading">Loading connections&hellip;</div>;
  }

  return (
    <div className={`connections-view${mobileShowEditor ? ' mobile-editor' : ''}`}>
      <div className="connections-list">
        <div className="connections-list-header">
          <span>Connections</span>
          <button type="button" className="connections-new-btn" onClick={createNew}>
            + New
          </button>
        </div>
        {connections.length === 0 && <div className="empty-state">No connections yet.</div>}
        {connections.map((c) => (
          <div
            key={c.id}
            className={`connections-row${c.id === selectedId ? ' selected' : ''}`}
            onClick={() => selectConnection(c.id)}
          >
            <span className="connections-row-name">{c.name}</span>
            <span className="connections-row-badge">{c.kind}</span>
            {c.isActive && <span className="connections-row-badge connections-row-badge-active">active</span>}
          </div>
        ))}
      </div>

      <div className="connections-editor">
        <button type="button" className="connections-back" onClick={() => setMobileShowEditor(false)}>
          &larr; Connections
        </button>

        {error && <div className="error-banner">{error}</div>}

        {!selected && !isNew && <div className="empty-state">Pick a connection, or create a new one.</div>}

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
                  disabled={selected.isActive || activating}
                >
                  {selected.isActive ? 'Active ✓' : activating ? 'Activating…' : 'Set as default'}
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
            {activateStatus && <div className="status">{activateStatus}</div>}

            <label>
              Kind
              <select
                value={draft.kind}
                onChange={(e) => {
                  const kind = e.target.value as Draft['kind'];
                  setDraft((d) => ({
                    ...d,
                    kind,
                    // A reuse-key pick that no longer matches the new kind (a key is provider-
                    // specific) falls back to "enter a new key" rather than silently keeping a
                    // stale, now-hidden option selected.
                    keySource:
                      d.keySource !== 'new' && d.keySource !== '' && !connections.some((c) => c.id === d.keySource && c.kind === kind)
                        ? 'new'
                        : d.keySource,
                  }));
                }}
              >
                <option value="openai-compatible">OpenAI-compatible (OpenRouter, DeepSeek, etc.)</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>

            {draft.kind === 'openai-compatible' && (
              <label>
                Base URL
                <input
                  value={draft.baseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                  placeholder="e.g. https://openrouter.ai/api/v1"
                />
              </label>
            )}

            <label>
              API key
              <select
                value={draft.keySource}
                onChange={(e) => {
                  const value = e.target.value;
                  setDraft((d) => {
                    const source = connections.find((c) => c.id === value);
                    return {
                      ...d,
                      keySource: value,
                      // Convenience default, not a lock — only fills an empty Base URL, never
                      // overwrites one the admin already typed.
                      baseUrl: !d.baseUrl && source?.baseUrl ? source.baseUrl : d.baseUrl,
                    };
                  });
                }}
              >
                {!isNew && <option value="">Leave unchanged</option>}
                <option value="new">Enter a new key</option>
                {connections.filter((c) => c.kind === draft.kind && c.id !== selected?.id).length > 0 && (
                  <optgroup label="Reuse an existing connection's key">
                    {connections
                      .filter((c) => c.kind === draft.kind && c.id !== selected?.id)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
              {draft.keySource === 'new' && (
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                  placeholder="required"
                />
              )}
              {draft.keySource && draft.keySource !== 'new' && (
                <div className="connections-field-note">
                  Will reuse {connections.find((c) => c.id === draft.keySource)?.name ?? 'the selected connection'}&rsquo;s key — no
                  need to re-enter it.
                </div>
              )}
            </label>

            <label>
              Model
              <select
                value={draft.model}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                disabled={isNew && modelOptions.length === 0}
              >
                {[draft.model, ...modelOptions.map((m) => m.id)]
                  .filter(Boolean)
                  .filter((id, i, ids) => ids.indexOf(id) === i)
                  .map((id) => {
                    const opt = modelOptions.find((m) => m.id === id);
                    return (
                      <option key={id} value={id}>
                        {id}
                        {opt?.pricing
                          ? ` — ${formatPricePerMillion(opt.pricing.prompt)} in / ${formatPricePerMillion(opt.pricing.completion)} out per 1M tok`
                          : ''}
                      </option>
                    );
                  })}
              </select>
              {isNew && (
                <input
                  className="connections-model-freeform"
                  value={draft.model}
                  onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                  placeholder="type a model id — the catalog above only appears once this connection is saved"
                />
              )}
              {modelsError && <div className="error-banner">{modelsError}</div>}
            </label>

            <label>
              <input
                type="checkbox"
                checked={draft.supportsVision}
                onChange={(e) => setDraft((d) => ({ ...d, supportsVision: e.target.checked }))}
              />
              {' '}This connection can see images (vision)
            </label>

            {draft.kind === 'openai-compatible' && (
              <fieldset className="connections-provider-pin">
                <legend>Provider routing (OpenRouter only)</legend>
                <div className="status">
                  Pin this model to a primary provider, plus an optional fallback, instead of accepting OpenRouter's
                  default routing across its whole provider set.
                </div>
                <div className="connections-provider-row">
                  <label>
                    Primary provider
                    <select
                      value={draft.providerPrimary}
                      onChange={(e) => setDraft((d) => ({ ...d, providerPrimary: e.target.value }))}
                    >
                      <option value="">(no pin — OpenRouter's default routing)</option>
                      {providerOptions.map((p) => (
                        <option key={p.tag} value={p.tag}>
                          {p.name}
                          {p.pricing
                            ? ` — ${formatPricePerMillion(p.pricing.prompt)} in / ${formatPricePerMillion(p.pricing.completion)} out per 1M tok`
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Fallback provider
                    <select
                      value={draft.providerFallback}
                      onChange={(e) => setDraft((d) => ({ ...d, providerFallback: e.target.value }))}
                      disabled={!draft.providerPrimary}
                    >
                      <option value="">(none)</option>
                      {providerOptions
                        .filter((p) => p.tag !== draft.providerPrimary)
                        .map((p) => (
                          <option key={p.tag} value={p.tag}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                {providersError && <div className="error-banner">{providersError}</div>}
                <label>
                  <input
                    type="checkbox"
                    checked={draft.allowFallbacks}
                    onChange={(e) => setDraft((d) => ({ ...d, allowFallbacks: e.target.checked }))}
                  />
                  {' '}Allow OpenRouter to fall back to other providers if the pinned one is unavailable
                </label>
                <label>
                  Quantization filter (comma-separated, optional)
                  <input
                    value={draft.quantizations}
                    onChange={(e) => setDraft((d) => ({ ...d, quantizations: e.target.value }))}
                    placeholder="e.g. fp16, bf16"
                  />
                </label>
              </fieldset>
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
                  title={dirty ? 'Save your changes first — Test calls through the saved connection' : undefined}
                >
                  {testing ? 'Testing…' : 'Test'}
                </button>
              )}
              {saved && <span className="saved-note">Saved.</span>}
            </div>
            {testResult && (
              <div className={testResult.ok ? 'saved-note' : 'error-banner'}>
                {testResult.ok
                  ? `Reached the provider in ${testResult.latencyMs}ms — replied "${testResult.reply}".`
                  : `Failed after ${testResult.latencyMs}ms: ${testResult.error}`}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
