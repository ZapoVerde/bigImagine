/**
 * @file plugins/cards/src/cardCodec.ts
 * @stamp 2026-08-22
 * @architectural-role Pure Function — SillyTavern-compatible Card parsing/encoding
 * @description Card codec kept in the Cards domain; source JSON remains the lossless export source.
 * @api-declaration parseCardJson, buildCardJson, encodePngCard, decodePngCard
 * @contract pure; no database, filesystem, network, or runtime Character access.
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

export interface CardCodecRow {
  name: string;
  persona: string;
  scenario: string;
  systemPrompt: string;
  exampleDialogue: string;
  greetings: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseCardJson(raw: unknown): ParsedCard {
  const top = record(raw);
  const data = record(top.data);
  const name = string(data.name) || string(top.name) || string(top.ch_name);
  if (!name.trim()) throw new Error('card JSON has no usable name field');
  const description = string(data.description) || string(top.description);
  const personality = string(data.personality) || string(top.personality);
  const persona = [description.trim(), personality.trim() ? `Personality: ${personality.trim()}` : '']
    .filter(Boolean).join('\n\n');
  const firstMes = string(data.first_mes) || string(top.first_mes);
  const alternates = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.filter((g): g is string => typeof g === 'string') : [];
  return {
    name: name.trim(), persona, scenario: string(data.scenario) || string(top.scenario),
    systemPrompt: string(data.system_prompt) || string(top.system_prompt),
    exampleDialogue: string(data.mes_example) || string(top.mes_example),
    greetings: [firstMes, ...alternates].map((g) => g.trim()).filter(Boolean),
    specVersion: top.spec === 'chara_card_v3' ? 'v3' : 'v2',
  };
}

export function buildCardJson(row: CardCodecRow): Record<string, unknown> {
  const [firstMes, ...alternateGreetings] = row.greetings;
  const fields = { name: row.name, description: row.persona, personality: '', scenario: row.scenario,
    first_mes: firstMes ?? '', mes_example: row.exampleDialogue };
  return { ...fields, spec: 'chara_card_v2', spec_version: '2.0', data: { ...fields,
    creator_notes: '', system_prompt: row.systemPrompt, post_history_instructions: '', tags: [],
    creator: '', character_version: '', alternate_greetings: alternateGreetings, extensions: {} } };
}

interface PngChunk { name: string; data: Uint8Array; }

function encodePngChunks(chunks: PngChunk[]): Uint8Array {
  const sizeBuf = new Uint8Array(4);
  const int32 = new Int32Array(sizeBuf.buffer);
  const uint32 = new Uint32Array(sizeBuf.buffer);
  const output = new Uint8Array(8 + chunks.reduce((total, chunk) => total + chunk.data.length + 12, 0));
  output.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let index = 8;
  for (const chunk of chunks) {
    const nameBytes = new Uint8Array([...chunk.name].map((char) => char.charCodeAt(0)));
    uint32[0] = chunk.data.length;
    output.set([sizeBuf[3]!, sizeBuf[2]!, sizeBuf[1]!, sizeBuf[0]!], index); index += 4;
    output.set(nameBytes, index); index += 4;
    output.set(chunk.data, index); index += chunk.data.length;
    int32[0] = crc32(Buffer.from(chunk.data), crc32(Buffer.from(nameBytes)));
    output.set([sizeBuf[3]!, sizeBuf[2]!, sizeBuf[1]!, sizeBuf[0]!], index); index += 4;
  }
  return output;
}

export function encodePngCard(pngBytes: Buffer, cardJsonString: string): Buffer {
  const chunks = extractPngChunks(new Uint8Array(pngBytes)) as PngChunk[];
  for (const chunk of [...chunks]) {
    if (chunk.name !== 'tEXt') continue;
    const keyword = decodePngText(chunk.data).keyword.toLowerCase();
    if (keyword === 'chara' || keyword === 'ccv3') chunks.splice(chunks.indexOf(chunk), 1);
  }
  chunks.splice(-1, 0, encodePngText('chara', Buffer.from(cardJsonString).toString('base64')));
  try {
    const v3 = JSON.parse(cardJsonString) as Record<string, unknown>;
    v3.spec = 'chara_card_v3'; v3.spec_version = '3.0';
    chunks.splice(-1, 0, encodePngText('ccv3', Buffer.from(JSON.stringify(v3)).toString('base64')));
  } catch { /* the v2 chunk remains valid when source JSON is not parseable */ }
  return Buffer.from(encodePngChunks(chunks));
}

export function decodePngCard(pngBytes: Buffer): string {
  const chunks = extractPngChunks(new Uint8Array(pngBytes)) as PngChunk[];
  const text = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => decodePngText(chunk.data));
  const ccv3 = text.find((chunk) => chunk.keyword.toLowerCase() === 'ccv3');
  const chara = text.find((chunk) => chunk.keyword.toLowerCase() === 'chara');
  if (ccv3) return Buffer.from(ccv3.text, 'base64').toString('utf8');
  if (chara) return Buffer.from(chara.text, 'base64').toString('utf8');
  throw new Error('PNG has no chara/ccv3 metadata chunk');
}
