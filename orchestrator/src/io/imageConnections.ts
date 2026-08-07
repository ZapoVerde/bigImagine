/**
 * @file orchestrator/src/io/imageConnections.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — DB-backed, admin-managed image generation connection registry
 * @description
 * Backs the Vistalyze image-generation subsystem's Connections Tab section
 * (docs/vistalyze_integration/endpoint.md §3, db/migrations/0068_image_connections.sql). The
 * image-generation counterpart to io/llmConnections.ts: real admin-managed rows — created,
 * renamed, deleted from the Connections tab, never a static env map — for image backends
 * (runware/fal-ai/pollinations/comfyui/openai-images), consumed per-generation by
 * orchestrator/generateLocationImage.ts via resolveActive().
 *
 * api_key_ciphertext mirrors llmConnections' own shape (io/fieldCipher.ts, AES-256-GCM): never
 * returned by list(), only decrypted by resolveById/resolveActive, which hand back an
 * ImageConnectionProfile for io/imageGen/index.ts's createImageGenProvider to consume — the one
 * place plaintext ever exists outside this module. Unlike llmConnections, the column is nullable:
 * only a local ComfyUI endpoint legitimately has no key — every cloud provider (Runware, fal.ai,
 * Pollinations, OpenAI) requires one — so hasApiKey is reported rather than assumed.
 *
 * is_active is enforced to at most one row by 0068's partial unique index, exactly like 0062's
 * llm_connections_one_active; activate() uses the same sequential-statement-within-one-transaction
 * shape llmConnections.ts's activate() settles on (a single writable-CTE statement hits the
 * partial unique index because both sub-updates run against the same snapshot). There is no
 * restart on switch — resolveActive() reads the column live on every generation call
 * (bi_principles.md §13), so the new active connection takes effect on the very next render.
 * remove() refuses to delete the active connection — the admin must activate a different one
 * first, the same "explicit successor" shape as llmConnections.
 *
 * @api-declaration
 * ImageConnectionRow — the redacted shape returned to callers (no apiKey plaintext or ciphertext;
 *   hasApiKey instead)
 * ImageConnectionProfile — the decrypted server-side shape io/imageGen/index.ts builds a provider
 *   adapter from
 * createImageConnectionStore(db, cipher) -> ImageConnectionStore
 *   .list() -> Promise<ImageConnectionRow[]>
 *   .create(init) -> Promise<ImageConnectionRow> — apiKey optional (only a local comfyui endpoint
 *     has none; every cloud provider, Pollinations included, requires one)
 *   .update(id, patch) -> Promise<ImageConnectionRow | undefined> — undefined if id doesn't exist
 *   .remove(id) -> Promise<'ok' | 'not_found' | 'is_active'>
 *   .activate(id) -> Promise<boolean> — false if id doesn't exist
 *   .resolveById(id) -> Promise<ImageConnectionProfile | undefined> — decrypts apiKey; server-side
 *     only, backs the Connections tab's Test button (adminServer.ts)
 *   .resolveActive() -> Promise<ImageConnectionProfile | undefined>
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via db.withSystemScope, AES via cipher)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { FieldCipher } from './fieldCipher.js';
import type { PostgresClient } from './postgres.js';

/** The redacted row shape — never exposes the API key in any form, only whether one is set. */
export interface ImageConnectionRow {
  id: string;
  name: string;
  kind: ImageConnectionKind;
  model: string;
  hasApiKey: boolean;
  baseUrl: string | null;
  width: number;
  height: number;
  samplingSteps: number;
  cfgScale: number;
  samplerName: string | null;
  masterPositiveStylePrefix: string | null;
  masterNegativePrompt: string | null;
  workflowParameters: Record<string, unknown> | null;
  isActive: boolean;
  updatedAt: string;
}

/** The decrypted shape handed to io/imageGen/index.ts — plaintext key exists only here. */
export interface ImageConnectionProfile {
  kind: ImageConnectionKind;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  width: number;
  height: number;
  samplingSteps: number;
  cfgScale: number;
  samplerName: string | null;
  masterPositiveStylePrefix: string | null;
  masterNegativePrompt: string | null;
  workflowParameters: Record<string, unknown> | null;
}

/** The closed vocabulary of implemented provider adapters (endpoint.md §3.2) — a row's kind names
 *  exactly one adapter in io/imageGen/, so dispatch is a straight lookup, never a fallback chain. */
export type ImageConnectionKind = 'runware' | 'fal-ai' | 'pollinations' | 'comfyui' | 'openai-images';

export interface ImageConnectionInit {
  name: string;
  kind: ImageConnectionKind;
  model: string;
  /** Optional — only a local comfyui endpoint has none (every cloud provider, Pollinations
   *  included, requires a key). */
  apiKey?: string;
  baseUrl?: string;
  width?: number;
  height?: number;
  samplingSteps?: number;
  cfgScale?: number;
  samplerName?: string;
  masterPositiveStylePrefix?: string;
  masterNegativePrompt?: string;
  workflowParameters?: Record<string, unknown>;
}

export interface ImageConnectionPatch {
  name?: string;
  kind?: ImageConnectionKind;
  model?: string;
  /** Undefined leaves the stored key untouched — only present when the admin is rotating it. */
  apiKey?: string;
  baseUrl?: string | null;
  width?: number;
  height?: number;
  samplingSteps?: number;
  cfgScale?: number;
  samplerName?: string | null;
  masterPositiveStylePrefix?: string | null;
  masterNegativePrompt?: string | null;
  workflowParameters?: Record<string, unknown> | null;
}

export interface ImageConnectionStore {
  list(): Promise<ImageConnectionRow[]>;
  create(init: ImageConnectionInit): Promise<ImageConnectionRow>;
  update(id: string, patch: ImageConnectionPatch): Promise<ImageConnectionRow | undefined>;
  remove(id: string): Promise<'ok' | 'not_found' | 'is_active'>;
  activate(id: string): Promise<boolean>;
  resolveById(id: string): Promise<ImageConnectionProfile | undefined>;
  resolveActive(): Promise<ImageConnectionProfile | undefined>;
}

interface ImageConnectionDbRow {
  id: string;
  name: string;
  kind: ImageConnectionKind;
  model: string;
  api_key_ciphertext: string | null;
  base_url: string | null;
  width: number;
  height: number;
  sampling_steps: number;
  cfg_scale: number;
  sampler_name: string | null;
  master_positive_style_prefix: string | null;
  master_negative_prompt: string | null;
  workflow_parameters: Record<string, unknown> | null;
  is_active: boolean;
  updated_at: string;
}

const ROW_COLUMNS = `id, name, kind, model, api_key_ciphertext, base_url, width, height, sampling_steps,
  cfg_scale, sampler_name, master_positive_style_prefix, master_negative_prompt, workflow_parameters,
  is_active, updated_at`;

function toRow(row: ImageConnectionDbRow): ImageConnectionRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    model: row.model,
    hasApiKey: row.api_key_ciphertext !== null,
    baseUrl: row.base_url,
    width: row.width,
    height: row.height,
    samplingSteps: row.sampling_steps,
    cfgScale: row.cfg_scale,
    samplerName: row.sampler_name,
    masterPositiveStylePrefix: row.master_positive_style_prefix,
    masterNegativePrompt: row.master_negative_prompt,
    workflowParameters: row.workflow_parameters,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  };
}

function toProfile(row: ImageConnectionDbRow, cipher: FieldCipher): ImageConnectionProfile {
  return {
    kind: row.kind,
    model: row.model,
    apiKey: row.api_key_ciphertext !== null ? cipher.decrypt(row.api_key_ciphertext) : null,
    baseUrl: row.base_url,
    width: row.width,
    height: row.height,
    samplingSteps: row.sampling_steps,
    cfgScale: row.cfg_scale,
    samplerName: row.sampler_name,
    masterPositiveStylePrefix: row.master_positive_style_prefix,
    masterNegativePrompt: row.master_negative_prompt,
    workflowParameters: row.workflow_parameters,
  };
}

export function createImageConnectionStore(db: PostgresClient, cipher: FieldCipher): ImageConnectionStore {
  return {
    async list() {
      const rows = await db.withSystemScope((session) =>
        session.query<ImageConnectionDbRow>(`select ${ROW_COLUMNS} from image_connections order by name`),
      );
      return rows.map(toRow);
    },

    async create(init) {
      const rows = await db.withSystemScope((session) =>
        session.query<ImageConnectionDbRow>(
          `insert into image_connections
             (name, kind, model, api_key_ciphertext, base_url, width, height, sampling_steps, cfg_scale,
              sampler_name, master_positive_style_prefix, master_negative_prompt, workflow_parameters)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           returning ${ROW_COLUMNS}`,
          [
            init.name,
            init.kind,
            init.model,
            init.apiKey ? cipher.encrypt(init.apiKey) : null,
            init.baseUrl ?? null,
            init.width ?? 1344,
            init.height ?? 768,
            init.samplingSteps ?? 30,
            init.cfgScale ?? 7.0,
            init.samplerName ?? null,
            init.masterPositiveStylePrefix ?? null,
            init.masterNegativePrompt ?? null,
            init.workflowParameters ? JSON.stringify(init.workflowParameters) : null,
          ],
        ),
      );
      return toRow(rows[0]);
    },

    async update(id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      function set(column: string, value: unknown): void {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.kind !== undefined) set('kind', patch.kind);
      if (patch.model !== undefined) set('model', patch.model);
      if (patch.apiKey !== undefined) set('api_key_ciphertext', patch.apiKey ? cipher.encrypt(patch.apiKey) : null);
      if (patch.baseUrl !== undefined) set('base_url', patch.baseUrl);
      if (patch.width !== undefined) set('width', patch.width);
      if (patch.height !== undefined) set('height', patch.height);
      if (patch.samplingSteps !== undefined) set('sampling_steps', patch.samplingSteps);
      if (patch.cfgScale !== undefined) set('cfg_scale', patch.cfgScale);
      if (patch.samplerName !== undefined) set('sampler_name', patch.samplerName);
      if (patch.masterPositiveStylePrefix !== undefined) set('master_positive_style_prefix', patch.masterPositiveStylePrefix);
      if (patch.masterNegativePrompt !== undefined) set('master_negative_prompt', patch.masterNegativePrompt);
      if (patch.workflowParameters !== undefined) {
        set('workflow_parameters', patch.workflowParameters ? JSON.stringify(patch.workflowParameters) : null);
      }
      if (sets.length === 0) {
        const rows = await db.withSystemScope((session) =>
          session.query<ImageConnectionDbRow>(`select ${ROW_COLUMNS} from image_connections where id = $1`, [id]),
        );
        return rows[0] ? toRow(rows[0]) : undefined;
      }
      sets.push('updated_at = now()');
      values.push(id);
      const rows = await db.withSystemScope((session) =>
        session.query<ImageConnectionDbRow>(
          `update image_connections set ${sets.join(', ')} where id = $${values.length} returning ${ROW_COLUMNS}`,
          values,
        ),
      );
      return rows[0] ? toRow(rows[0]) : undefined;
    },

    async remove(id) {
      const rows = await db.withSystemScope((session) =>
        session.query<{ is_active: boolean }>('select is_active from image_connections where id = $1', [id]),
      );
      if (!rows[0]) return 'not_found';
      if (rows[0].is_active) return 'is_active';
      await db.withSystemScope((session) => session.query('delete from image_connections where id = $1', [id]));
      return 'ok';
    },

    async activate(id) {
      // Sequential statements inside one withSystemScope transaction — the same shape
      // llmConnections.ts's activate() uses: a single writable-CTE statement would hit
      // image_connections_one_active (0068's partial unique index) because both sub-updates run
      // against the same query-start snapshot, while sequential statements see each other's
      // effect and never expose a window with zero or two active rows. The existence probe comes
      // first so a nonexistent id (404 at the route) leaves the current active row untouched —
      // never a cleared active flag on a failed activation.
      return db.withSystemScope(async (session) => {
        const existing = await session.query<{ id: string }>('select id from image_connections where id = $1', [id]);
        if (!existing[0]) return false;
        await session.query('update image_connections set is_active = false where is_active and id != $1', [id]);
        const rows = await session.query<{ id: string }>(
          'update image_connections set is_active = true, updated_at = now() where id = $1 returning id',
          [id],
        );
        // A concurrent delete of the target between the probe and this update must not leave the
        // incumbent deactivated: a normal return here would COMMIT the clear. Throw instead, which
        // rolls the whole transaction back (io/postgres.ts's inTransaction) — the incumbent stays
        // active and the route 404s. The `returning` guard makes this path detectable rather than
        // silently reporting success for a row that vanished mid-transaction.
        if (rows.length === 0) throw new Error(`image connection ${id} vanished during activation`);
        return true;
      });
    },

    async resolveById(id) {
      const rows = await db.withSystemScope((session) =>
        session.query<ImageConnectionDbRow>(`select ${ROW_COLUMNS} from image_connections where id = $1`, [id]),
      );
      return rows[0] ? toProfile(rows[0], cipher) : undefined;
    },

    async resolveActive() {
      const rows = await db.withSystemScope((session) =>
        session.query<ImageConnectionDbRow>(`select ${ROW_COLUMNS} from image_connections where is_active`),
      );
      return rows[0] ? toProfile(rows[0], cipher) : undefined;
    },
  };
}
