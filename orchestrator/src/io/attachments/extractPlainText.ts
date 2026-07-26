/**
 * @file orchestrator/src/io/attachments/extractPlainText.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function — decodes a plain-text/code/data file's bytes to text
 * @description
 * Covers the "Direct Read" track: plain text, Markdown, source code, and structured data
 * (JSON/CSV/YAML/XML) all need the same treatment — decode the bytes and, for JSON specifically,
 * reformat for readability — never a conversion step, since the file's own bytes already are its
 * content. Fencing the result in a language-tagged Markdown code block and capping its size are
 * dispatchExtraction.ts's job, done in that order (cap the raw text, then fence it) — capping
 * already-fenced Markdown could cut the closing fence off and break rendering downstream.
 *
 * Falls back from UTF-8 to Latin-1 on a decode failure — Node has no built-in Windows-1252
 * decoder, and Latin-1 (which never throws) is a close enough stand-in for the common case this
 * exists for: an old CSV/text export from Windows/Excel that isn't UTF-8.
 *
 * @api-declaration
 * PlainTextExtraction
 * extractPlainText(filename, bytes) — { content, languageTag }
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

const LANGUAGE_TAGS: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.sql': 'sql',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.xml': 'xml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

export interface PlainTextExtraction {
  content: string;
  languageTag: string;
}

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx).toLowerCase();
}

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

function prettyPrintIfJson(text: string, extension: string): string {
  if (extension !== '.json') return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text; // not valid JSON (or already pretty) — send as-is rather than failing the upload
  }
}

export function extractPlainText(filename: string, bytes: Buffer): PlainTextExtraction {
  const extension = extensionOf(filename);
  const content = prettyPrintIfJson(decodeText(bytes), extension);
  return { content, languageTag: LANGUAGE_TAGS[extension] ?? '' };
}
