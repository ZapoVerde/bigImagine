/**
 * @file plugins/characters/src/cardCodec.ts
 * @stamp 2026-08-05
 * @architectural-role Pure Function — SillyTavern-compatible character card parsing/encoding
 * @description
 * The card-spec half of the Character Roster (docs/spec.md §6, docs/bi_principles.md §7's
 * lossless-round-trip requirement) that the original data-only characters plugin deliberately
 * skipped (see index.ts's own preamble). Ported 1:1 from the real, deployed SillyTavern install at
 * stacks/sillytavern/st-source/src/character-card-parser.js and src/png/encode.js — same PNG tEXt
 * chunk embedding (`chara` = V2 base64 JSON, `ccv3` = V3 base64 JSON, V3 preferred on read), same
 * `png-chunks-extract`/`png-chunk-text`/`crc` libraries, so a card round-trips through both ST and
 * BigImagine without either side needing to know which one produced it.
 *
 * parseCardJson normalizes V1 (flat)/V2/V3 card JSON into this table's columns. `characters` has
 * one `persona` column where the spec has separate description/personality — both are concatenated
 * into persona here (a deliberate, accepted simplification, not a bug); the caller is expected to
 * keep the original parsed JSON as source_json so export stays exact regardless of what persona
 * collapsed them into. buildCardJson is the fallback for a character with no source_json (created
 * via the manual form, never imported) — it has no split to recover, so the whole persona becomes
 * `description` and `personality` comes back empty.
 *
 * @api-declaration
 * parseCardJson(raw) — normalizes V1/V2/V3 card JSON into ParsedCard; throws if no usable name
 * buildCardJson(row) — reconstructs a spec-compliant V2 JSON object from a characters row
 * encodePngCard(pngBytes, cardJsonString) — embeds cardJsonString into pngBytes as chara+ccv3
 *   tEXt chunks, replacing any that were already there
 * decodePngCard(pngBytes) — extracts the card JSON string from a PNG's tEXt chunks (ccv3 preferred,
 *   falling back to chara); throws if neither is present
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO; operates only on the buffers/objects it's given)
 *     state_ownership: []
 *     external_io:     []
 */

import { crc32 } from 'crc';
import { decode as decodePngText, encode as encodePngText } from 'png-chunk-text';
import extractPngChunks from 'png-chunks-extract';

export interface ParsedCard {
  name: string;
  persona: string;
  scenario: string;
  systemPrompt: string;
  exampleDialogue: string;
  greetings: string[];
  specVersion: 'v2' | 'v3';
}

export interface CharacterCardRow {
  name: string;
  persona: string;
  scenario: string;
  systemPrompt: string;
  exampleDialogue: string;
  greetings: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseCardJson(raw: unknown): ParsedCard {
  const top = asRecord(raw);
  // V2/V3 fields live under `data`; a flat V1 card has them at the top level. `data` fields win
  // when both are present, matching character-card-parser.js's own precedence.
  const data = asRecord(top.data);

  const name = asString(data.name) || asString(top.name) || asString(top.ch_name);
  if (!name.trim()) {
    throw new Error('card JSON has no usable name field');
  }

  const description = asString(data.description) || asString(top.description);
  const personality = asString(data.personality) || asString(top.personality);
  const persona = [description.trim(), personality.trim() ? `Personality: ${personality.trim()}` : '']
    .filter((part) => part.length > 0)
    .join('\n\n');

  const firstMes = asString(data.first_mes) || asString(top.first_mes);
  const alternates = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.filter((g): g is string => typeof g === 'string')
    : [];
  const greetings = [firstMes, ...alternates].map((g) => g.trim()).filter((g) => g.length > 0);

  return {
    name: name.trim(),
    persona,
    scenario: asString(data.scenario) || asString(top.scenario),
    systemPrompt: asString(data.system_prompt) || asString(top.system_prompt),
    exampleDialogue: asString(data.mes_example) || asString(top.mes_example),
    greetings,
    specVersion: top.spec === 'chara_card_v3' ? 'v3' : 'v2',
  };
}

export function buildCardJson(row: CharacterCardRow): Record<string, unknown> {
  const [firstMes, ...alternateGreetings] = row.greetings;
  const fields = {
    name: row.name,
    description: row.persona,
    personality: '',
    scenario: row.scenario,
    first_mes: firstMes ?? '',
    mes_example: row.exampleDialogue,
  };
  return {
    ...fields,
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      ...fields,
      creator_notes: '',
      system_prompt: row.systemPrompt,
      post_history_instructions: '',
      tags: [],
      creator: '',
      character_version: '',
      alternate_greetings: alternateGreetings,
      extensions: {},
    },
  };
}

interface PngChunk {
  name: string;
  data: Uint8Array;
}

// Ported from stacks/sillytavern/st-source/src/png/encode.js — no maintained package exposes an
// encoder alongside png-chunks-extract's decoder, so this stays a straight port rather than a new
// dependency for one function. Big-endian length + CRC32(name-bytes + data) per PNG chunk, same as
// every PNG encoder; kept private since nothing outside this file needs raw chunk assembly.
function encodePngChunks(chunks: PngChunk[]): Uint8Array {
  const sizeBuf = new Uint8Array(4);
  const int32 = new Int32Array(sizeBuf.buffer);
  const uint32 = new Uint32Array(sizeBuf.buffer);

  let totalSize = 8;
  for (const chunk of chunks) totalSize += chunk.data.length + 12;

  const output = new Uint8Array(totalSize);
  output.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let idx = 8;

  for (const { name, data } of chunks) {
    const nameBytes = new Uint8Array([name.charCodeAt(0), name.charCodeAt(1), name.charCodeAt(2), name.charCodeAt(3)]);

    uint32[0] = data.length;
    output[idx++] = sizeBuf[3]!;
    output[idx++] = sizeBuf[2]!;
    output[idx++] = sizeBuf[1]!;
    output[idx++] = sizeBuf[0]!;

    output.set(nameBytes, idx);
    idx += 4;
    output.set(data, idx);
    idx += data.length;

    int32[0] = crc32(Buffer.from(data), crc32(Buffer.from(nameBytes)));
    output[idx++] = sizeBuf[3]!;
    output[idx++] = sizeBuf[2]!;
    output[idx++] = sizeBuf[1]!;
    output[idx++] = sizeBuf[0]!;
  }

  return output;
}

export function encodePngCard(pngBytes: Buffer, cardJsonString: string): Buffer {
  const chunks = extractPngChunks(new Uint8Array(pngBytes)) as PngChunk[];

  for (const chunk of [...chunks]) {
    if (chunk.name !== 'tEXt') continue;
    const decoded = decodePngText(chunk.data);
    const keyword = decoded.keyword.toLowerCase();
    if (keyword === 'chara' || keyword === 'ccv3') {
      chunks.splice(chunks.indexOf(chunk), 1);
    }
  }

  // New chunks land just before IEND, same insertion point character-card-parser.js uses.
  chunks.splice(-1, 0, encodePngText('chara', Buffer.from(cardJsonString, 'utf8').toString('base64')));

  try {
    const v3Data = JSON.parse(cardJsonString) as Record<string, unknown>;
    v3Data.spec = 'chara_card_v3';
    v3Data.spec_version = '3.0';
    const v3Base64 = Buffer.from(JSON.stringify(v3Data), 'utf8').toString('base64');
    chunks.splice(-1, 0, encodePngText('ccv3', v3Base64));
  } catch {
    // Best-effort v3 mirror, same as upstream — a v2 chunk alone is still a valid, readable card.
  }

  return Buffer.from(encodePngChunks(chunks));
}

export function decodePngCard(pngBytes: Buffer): string {
  const chunks = extractPngChunks(new Uint8Array(pngBytes)) as PngChunk[];
  const textChunks = chunks.filter((c) => c.name === 'tEXt').map((c) => decodePngText(c.data));

  const ccv3 = textChunks.find((c) => c.keyword.toLowerCase() === 'ccv3');
  if (ccv3) return Buffer.from(ccv3.text, 'base64').toString('utf8');

  const chara = textChunks.find((c) => c.keyword.toLowerCase() === 'chara');
  if (chara) return Buffer.from(chara.text, 'base64').toString('utf8');

  throw new Error('PNG has no chara/ccv3 metadata chunk');
}
