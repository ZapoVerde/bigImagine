/**
 * @file plugins/cards/src/importCardTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — imports a PNG or JSON Card
 * @api-declaration createImportCardTool() — returns import_card with cardId result
 * @contract parses input then writes only cards/Card media and Card-owned books.
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { decodePngCard, parseCardJson } from './cardCodec.js';
import { insertCardFromCard } from './insertCardFromCard.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function createImportCardTool(): RegisteredTool {
  return {
    definition: { name: 'import_card', description: 'Import a reusable Card from a compatible PNG or JSON file.', parameters: {
      type: 'object', properties: { filename: { type: 'string' }, fileBase64: { type: 'string' } },
      required: ['filename', 'fileBase64'], additionalProperties: false,
    } },
    handler: async (args, ctx) => {
      const value = args as Record<string, unknown>;
      if (!value || typeof value.filename !== 'string' || typeof value.fileBase64 !== 'string' || !value.fileBase64) {
        throw new Error('import_card requires filename: string and fileBase64: string');
      }
      const bytes = Buffer.from(value.fileBase64, 'base64');
      const isPng = bytes.subarray(0, 8).equals(PNG_MAGIC);
      let sourceJson: unknown;
      try { sourceJson = JSON.parse(isPng ? decodePngCard(bytes) : bytes.toString('utf8')); }
      catch { throw new Error(`${value.filename} is neither a valid card PNG nor valid card JSON`); }
      const parsed = parseCardJson(sourceJson);
      return insertCardFromCard(ctx.db, ctx.userId, parsed, sourceJson, ctx.embeddings, isPng ? bytes : undefined);
    },
  };
}
