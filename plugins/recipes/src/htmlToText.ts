/**
 * @file plugins/recipes/src/htmlToText.ts
 * @stamp 2026-07-23
 * @architectural-role Pure Function module — crude HTML-to-text for the LLM fallback path
 * @description
 * Not a real HTML parser — just enough to turn a fetched page into text an LLM can extract a
 * recipe from when schemaOrgRecipeParser.ts finds nothing. Strips script/style content (mostly
 * JSON blobs and JS, pure noise for extraction), strips remaining tags, decodes the handful of
 * entities recipe text actually contains, and truncates — recipe content is reliably near the top
 * of a page's body, and there's no reason to spend context budget on footer/comments/related-posts.
 *
 * @api-declaration
 * htmlToText(html, maxLength = 12000)
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#039;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function htmlToText(html: string, maxLength = 12000): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  for (const [entity, replacement] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(replacement);
  }

  text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

  return text.length > maxLength ? text.slice(0, maxLength) : text;
}
