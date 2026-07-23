/**
 * @file orchestrator/src/io/fieldCipher.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — at-rest encryption for sensitive text columns
 * @description
 * Protects content columns (currently unstructured_notes.raw_text and .summary_short) against
 * anyone with filesystem/Postgres access but no BIGBRAIN_FIELD_ENCRYPTION_KEY — a stolen disk, a
 * leaked backup, casual `psql`. This is a single server-held key (config-driven, fails closed on
 * missing/malformed config, per bb_principles.md §6), not per-user key material: whoever holds
 * BIGBRAIN_FIELD_ENCRYPTION_KEY (the deployer) can always decrypt everything. A genuinely
 * admin-blind per-user-key scheme is a deliberately deferred, larger change — see spec.md's
 * corrections for the tradeoff this was chosen over.
 *
 * bigBrain's own processing (classification, embedding, chat) still needs plaintext, so
 * encryption happens at the IO boundary only: decrypt right before content reaches the LLM/
 * embedding provider, encrypt right before it's written to Postgres. Nothing downstream of this
 * module ever sees ciphertext or the key.
 *
 * vector_embed is never encrypted — pgvector needs the raw vector to do similarity search, so it
 * remains a queryable (if not literally readable) semantic fingerprint of the plaintext. Encrypted
 * columns stay `text` in schema (ciphertext is base64), so turning this on/off is a config change,
 * not a migration.
 *
 * @api-declaration
 * createFieldCipher(env) — reads BIGBRAIN_FIELD_ENCRYPTION_KEY (32 raw bytes, base64-encoded)
 * FieldCipher.encrypt(plaintext) / .decrypt(ciphertext) — AES-256-GCM, random IV per call, output
 *   is base64(iv[12] || authTag[16] || ciphertext)
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads process env at construction; encrypt/decrypt use a CSPRNG)
 *     state_ownership: []
 *     external_io:     []
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface FieldCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export function createFieldCipher(env: NodeJS.ProcessEnv = process.env): FieldCipher {
  const rawKey = env.BIGBRAIN_FIELD_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error(
      'BIGBRAIN_FIELD_ENCRYPTION_KEY is required — generate one with `openssl rand -base64 32` (see .env.example)',
    );
  }

  const key = Buffer.from(rawKey, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `BIGBRAIN_FIELD_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}) — generate one with \`openssl rand -base64 32\``,
    );
  }

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
    },

    decrypt(ciphertext: string): string {
      const buf = Buffer.from(ciphertext, 'base64');
      if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
        throw new Error('ciphertext too short to contain an IV and auth tag — not a value this cipher wrote');
      }
      const iv = buf.subarray(0, IV_BYTES);
      const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
      const encrypted = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    },
  };
}
