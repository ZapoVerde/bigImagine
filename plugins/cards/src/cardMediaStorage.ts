/**
 * @file plugins/cards/src/cardMediaStorage.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — Card-owned imported media bytes
 * @description Reuses the established UUID-keyed local layout; Card tools authorize ownership in SQL.
 * @api-declaration writeCardMedia, readCardMedia, deleteCardMedia
 * @contract filesystem only; never reads or writes runtime Character rows or visual state.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE_DIR = resolve(process.env.BIGBRAIN_CHARACTER_MEDIA_DIR ?? '/app/character-media');
const pathFor = (cardId: string) => join(BASE_DIR, `${cardId}.png`);

export async function writeCardMedia(cardId: string, bytes: Buffer): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
  await writeFile(pathFor(cardId), bytes);
}

export async function readCardMedia(cardId: string): Promise<Buffer | null> {
  try { return await readFile(pathFor(cardId)); } catch { return null; }
}

export async function deleteCardMedia(cardId: string): Promise<void> {
  await rm(pathFor(cardId), { force: true });
}
