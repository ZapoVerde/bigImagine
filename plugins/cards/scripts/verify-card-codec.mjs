// Focused pure Card codec verification: metadata survives PNG embedding and source JSON remains
// the export authority for fields that are intentionally normalized into Card columns.
import { buildCardJson, decodePngCard, encodePngCard, parseCardJson } from '../dist/cardCodec.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); console.log(`ok: ${message}`); };
const blank = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const source = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Elara', description: 'Knight', personality: 'Loyal', first_mes: 'Hello', alternate_greetings: ['Hi'], scenario: 'Keep', system_prompt: 'Terse', mes_example: '' } };
const png = encodePngCard(blank, JSON.stringify(source));
const decoded = JSON.parse(decodePngCard(png));
assert(decoded.data.name === 'Elara' && decoded.data.alternate_greetings[0] === 'Hi', 'PNG Card metadata round-trips');
const parsed = parseCardJson(source);
assert(parsed.persona.includes('Knight') && parsed.persona.includes('Personality: Loyal'), 'Card parser preserves supported source fields');
const built = buildCardJson({ name: 'Bare', persona: 'Persona', scenario: '', systemPrompt: '', exampleDialogue: '', greetings: ['Hello'] });
assert(built.data.first_mes === 'Hello', 'manual Card fallback builds a supported V2 source shape');
