import { useCallback, useEffect, useState } from 'react';
import { ApiError, adminGetCleanupSettings, adminSetCleanupSettings, getCleanupJobs, listChats, runCleanupNow } from '../api/client';
import type { ChatSummary, CleanupJob, CleanupSettings, SlopRule } from '../api/types';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import './CleanupView.css';

// The Cleanup page — the setup surface for the async heuristic cleanup subloop (migration 0072,
// cleanupLoop.ts), replacing the retired inline cleanup prompt. Two halves:
//
//   1. SETUP (admin-gated, like every Settings-tab field): what the subloop strips (the
//      slop-rules table — "forbidden phrases/words/slop"), and the two format contracts the
//      header/footer repairs enforce — each expressed as a regex trigger + a repair prompt in
//      the user's own words ("the format expressed as a prompt"). All of it is re-read live
//      every tick, so a save takes effect on the next poll, no restart.
//   2. ACTIVITY (user-scoped, no admin key): pick one of your RP chats, see its recent cleanup
//      jobs (what was cleaned / flagged, newest first), and trigger a run-now pass.
//
// The per-chat opt-in itself lives in ChatSettings (the "Async cleanup pass" toggle) and is
// configured here per RP chat on the activity side; the header/footer/slop config below is
// household-wide.
export default function CleanupView({ apiKey }: { apiKey: string | null }) {
  // --- setup (admin) ---
  const [settings, setSettings] = useState<CleanupSettings | null>(null);
  const [headerRegex, setHeaderRegex] = useState('');
  const [headerPrompt, setHeaderPrompt] = useState('');
  const [footerRegex, setFooterRegex] = useState('');
  const [footerPrompt, setFooterPrompt] = useState('');
  const [slopRules, setSlopRules] = useState<SlopRule[]>([]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const loaded = await adminGetCleanupSettings(key);
      setSettings(loaded);
      setHeaderRegex(loaded.headerRegex);
      setHeaderPrompt(loaded.headerPrompt);
      setFooterRegex(loaded.footerRegex);
      setFooterPrompt(loaded.footerPrompt);
      setSlopRules(loaded.slopRules);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

  // --- activity (user-scoped) ---
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState('');
  const [jobs, setJobs] = useState<CleanupJob[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);

  useEffect(() => {
    listChats(apiKey, undefined, 'rp').then(setChats).catch(() => setChats([]));
  }, [apiKey]);

  const refreshJobs = useCallback(
    (chatId: string) => {
      if (!chatId) {
        setJobs(null);
        return;
      }
      setJobsError(null);
      getCleanupJobs(chatId, apiKey, 20)
        .then(setJobs)
        .catch((err) => {
          setJobs([]);
          setJobsError(err instanceof ApiError ? err.message : 'failed to load cleanup jobs');
        });
    },
    [apiKey],
  );

  useEffect(() => {
    refreshJobs(selectedChatId);
  }, [selectedChatId, refreshJobs]);

  const save = async () => {
    setSaveStatus(null);
    try {
      const updated = await adminSetCleanupSettings(
        {
          header_regex: headerRegex,
          header_prompt: headerPrompt,
          footer_regex: footerRegex,
          footer_prompt: footerPrompt,
          slop_rules: slopRules.map((r) => ({
            setName: r.setName,
            position: r.position,
            pattern: r.pattern,
            flags: r.flags,
            action: r.action,
            replacement: r.replacement,
            llmPrompt: r.llmPrompt,
            enabled: r.enabled,
          })),
        },
        adminKey,
      );
      setSettings(updated);
      setSaveStatus('Saved — the subloop picks it up on its next poll, no restart needed.');
    } catch (err) {
      setSaveStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
    }
  };

  const updateRule = (ruleId: string, patch: Partial<SlopRule>) => {
    setSlopRules((rules) => rules.map((r) => (r.ruleId === ruleId ? { ...r, ...patch } : r)));
  };

  const addRule = () => {
    setSlopRules((rules) => [
      ...rules,
      {
        ruleId: crypto.randomUUID(),
        setName: 'custom',
        position: rules.length,
        pattern: '',
        flags: 'i',
        action: 'remove',
        replacement: null,
        llmPrompt: null,
        enabled: true,
      },
    ]);
  };

  const removeRule = (ruleId: string) => {
    setSlopRules((rules) => rules.filter((r) => r.ruleId !== ruleId));
  };

  const runNow = async () => {
    if (!selectedChatId) return;
    setRunStatus(null);
    try {
      await runCleanupNow(selectedChatId, apiKey);
      setRunStatus('Started — results show here on the next poll.');
      setTimeout(() => refreshJobs(selectedChatId), 1500);
    } catch (err) {
      setRunStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to start');
    }
  };

  if (checking) {
    return <div className="cleanup-view" />;
  }

  if (!unlocked) {
    return (
      <div className="cleanup-view">
        <h1>Cleanup</h1>
        <p className="cleanup-subtitle">
          Setup for the async cleanup pass — what it strips and the header/footer formats it enforces. Admin key required.
        </p>
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

  if (!settings) {
    return <div className="cleanup-view loading">Loading cleanup settings&hellip;</div>;
  }

  return (
    <div className="cleanup-view">
      <h1>Cleanup</h1>
      <p className="cleanup-subtitle">
        The async cleanup subloop rewrites each reply after it lands — stripping the slop below and repairing the
        header/footer formats below that. Everything here is re-read live on every tick; the original reply is always
        kept as a swipe.
      </p>

      <section className="cleanup-section">
        <h2>Forbidden phrases / slop</h2>
        <p className="cleanup-note">
          Each row is one regex trigger + action. <code>remove</code> deletes the match (optionally replaced by{' '}
          <code>replacement</code>, with <code>$1</code>&hellip; backreferences). <code>replace-paragraph</code>{' '}
          fires the <code>llm prompt</code> per paragraph containing the match and splices the result back.{' '}
          <code>llm</code> fires it once over the whole message. <code>set name</code> groups rules;{' '}
          <code>position</code> orders them within a set.
          <br />
          In an <code>llm prompt</code>, <code>{'{{keyword}}'}</code> is the exact phrase that triggered the rule,{' '}
          <code>{'{{paragraph}}'}</code> the paragraph containing it (<code>replace-paragraph</code> only), and{' '}
          <code>{'{{message}}'}</code> the whole reply — they resolve at run time.
        </p>
        <div className="cleanup-slop-list">
          {slopRules.map((rule) => (
            <div className="cleanup-slop-row" key={rule.ruleId}>
              <label>
                set
                <input
                  value={rule.setName}
                  onChange={(e) => updateRule(rule.ruleId, { setName: e.target.value })}
                />
              </label>
              <label>
                pos
                <input
                  type="number"
                  min={0}
                  value={rule.position}
                  onChange={(e) => updateRule(rule.ruleId, { position: Number(e.target.value) || 0 })}
                />
              </label>
              <label className="cleanup-slop-pattern">
                pattern
                <input
                  value={rule.pattern}
                  placeholder="regex, e.g. \bdelve(?:d|s|ing)?\b"
                  onChange={(e) => updateRule(rule.ruleId, { pattern: e.target.value })}
                />
              </label>
              <label>
                flags
                <input value={rule.flags} placeholder="i" onChange={(e) => updateRule(rule.ruleId, { flags: e.target.value })} />
              </label>
              <label>
                action
                <select
                  value={rule.action}
                  onChange={(e) => updateRule(rule.ruleId, { action: e.target.value as SlopRule['action'] })}
                >
                  <option value="remove">remove</option>
                  <option value="replace-paragraph">replace-paragraph</option>
                  <option value="llm">llm</option>
                </select>
              </label>
              {rule.action === 'remove' && (
                <label className="cleanup-slop-replacement">
                  replacement
                  <input
                    value={rule.replacement ?? ''}
                    placeholder="empty = delete the match"
                    onChange={(e) => updateRule(rule.ruleId, { replacement: e.target.value || null })}
                  />
                </label>
              )}
              {rule.action !== 'remove' && (
                <label className="cleanup-slop-prompt">
                  llm prompt
                  <textarea
                    rows={3}
                    value={rule.llmPrompt ?? ''}
                    placeholder='e.g. The reply contains "{{keyword}}" — remove it. {{paragraph}}'
                    onChange={(e) => updateRule(rule.ruleId, { llmPrompt: e.target.value || null })}
                  />
                </label>
              )}
              <label className="cleanup-slop-enabled">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => updateRule(rule.ruleId, { enabled: e.target.checked })}
                />
                on
              </label>
              <button type="button" className="cleanup-slop-remove" title="Remove this rule" onClick={() => removeRule(rule.ruleId)}>
                &times;
              </button>
            </div>
          ))}
          {slopRules.length === 0 && <p className="cleanup-note">No slop rules — add one to start stripping phrases.</p>}
        </div>
        <div className="cleanup-row-actions">
          <button type="button" onClick={addRule}>
            + Add rule
          </button>
          <span className="cleanup-hint">{slopRules.length === 1 ? '1 rule' : `${slopRules.length} rules`}</span>
        </div>
      </section>

      <section className="cleanup-section">
        <h2>Header format</h2>
        <p className="cleanup-note">
          The trigger regex that recognizes a conforming scene header, and the repair prompt — the format expressed as a
          prompt — used when a reply's header is missing or malformed. <code>{'{{history, N}}'}</code> and{' '}
          <code>{'{{message}}'}</code> macros resolve at run time.
        </p>
        <label>
          Header regex
          <input value={headerRegex} onChange={(e) => setHeaderRegex(e.target.value)} />
        </label>
        <label>
          Header repair prompt
          <textarea rows={6} value={headerPrompt} onChange={(e) => setHeaderPrompt(e.target.value)} />
        </label>
      </section>

      <section className="cleanup-section">
        <h2>Footer format</h2>
        <p className="cleanup-note">
          The trigger regex for a conforming footer (the inner-thoughts details block), and its repair prompt. Same
          macros as the header.
        </p>
        <label>
          Footer regex
          <input value={footerRegex} onChange={(e) => setFooterRegex(e.target.value)} />
        </label>
        <label>
          Footer repair prompt
          <textarea rows={6} value={footerPrompt} onChange={(e) => setFooterPrompt(e.target.value)} />
        </label>
      </section>

      <div className="cleanup-section-actions">
        <button type="button" onClick={save}>
          Save setup
        </button>
        {saveStatus && <span className="cleanup-save-status">{saveStatus}</span>}
      </div>

      <section className="cleanup-section">
        <h2>Recent activity</h2>
        <p className="cleanup-note">
          Pick one of your RP chats to see what the subloop has done to its replies — newest first, with flagged repairs
          shown in amber — or force an immediate pass now.
        </p>
        <div className="cleanup-activity-row">
          <select value={selectedChatId} onChange={(e) => setSelectedChatId(e.target.value)}>
            <option value="">Pick a chat&hellip;</option>
            {chats.map((c) => (
              <option key={c.chatId} value={c.chatId}>
                {c.title}
              </option>
            ))}
          </select>
          <button type="button" onClick={runNow} disabled={!selectedChatId}>
            Run now
          </button>
          {runStatus && <span className="cleanup-save-status">{runStatus}</span>}
        </div>
        {jobsError && <div className="error-banner">{jobsError}</div>}
        {selectedChatId && jobs && (
          <table className="cleanup-jobs-table">
            <thead>
              <tr>
                <th>State</th>
                <th>When</th>
                <th>Note</th>
                <th>Reply preview</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.jobId} className={job.status === 'flagged' || job.status === 'error' ? 'cleanup-job-flagged' : undefined}>
                  <td>{job.status === 'done' ? (job.changed ? 'modified' : 'unchanged') : job.status}</td>
                  <td>{new Date(job.createdAt).toLocaleString()}</td>
                  <td>{job.notes ?? ''}</td>
                  <td className="cleanup-job-preview">{job.preview}</td>
                </tr>
              ))}
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={4}>No cleanup jobs for this chat yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
