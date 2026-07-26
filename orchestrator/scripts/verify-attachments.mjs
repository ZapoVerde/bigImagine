// Proves the file-upload/attachment pipeline end to end: pure extraction/truncation/splicing
// logic, then a real multipart POST against a real running httpServer instance (real Busboy
// parsing, not a fake), and that an attachment reaches the model for one turn without ever being
// persisted to chat history.

import { extractPlainText } from '../dist/io/attachments/extractPlainText.js';
import { extractAttachmentText } from '../dist/io/attachments/dispatchExtraction.js';
import { truncateForContext, buildTruncationBanner, DEFAULT_ATTACHMENT_CHAR_CAP } from '../dist/util/truncateForContext.js';
import { appendAttachmentsToLatestUserMessage } from '../dist/util/attachmentContext.js';
import { startHttpServer } from '../dist/server/httpServer.js';
import { createToolRegistry } from '../dist/orchestrator/toolRegistry.js';
import { createApiKeyStore } from '../dist/server/apiKeyStore.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createStubLlmProvider } from '../dist/io/llm/stub.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- extractPlainText: decoding, language tags, JSON pretty-printing ---

{
  const { content, languageTag } = extractPlainText('notes.txt', Buffer.from('hello world', 'utf8'));
  assert(content === 'hello world', 'a plain .txt file decodes verbatim');
  assert(languageTag === '', 'a .txt file gets no language tag');
}

{
  const { languageTag } = extractPlainText('script.py', Buffer.from('print(1)', 'utf8'));
  assert(languageTag === 'python', 'a .py extension maps to the python language tag');
}

{
  const { content } = extractPlainText('data.json', Buffer.from('{"a":1,"b":[1,2]}', 'utf8'));
  assert(content === JSON.stringify({ a: 1, b: [1, 2] }, null, 2), 'valid JSON is pretty-printed with 2-space indent');
}

{
  const { content } = extractPlainText('data.json', Buffer.from('{not valid json', 'utf8'));
  assert(content === '{not valid json', 'invalid JSON falls back to the raw text instead of failing');
}

{
  // Latin-1 encodes 0xE9 as "é" — not valid UTF-8 on its own, so the fatal UTF-8 decoder must
  // throw and the Latin-1 fallback must take over instead of producing mojibake or crashing.
  const legacyBytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "caf" + Latin-1 0xE9
  const { content } = extractPlainText('legacy.csv', legacyBytes);
  assert(content === 'café', 'a non-UTF-8 byte sequence falls back to Latin-1 decoding instead of throwing');
}

// --- truncateForContext / buildTruncationBanner ---

{
  const result = truncateForContext('short text', 100);
  assert(result.truncated === false && result.text === 'short text', 'text within the cap is returned unchanged');
  assert(result.meta.totalChars === 10, 'meta reports the true total character count even when not truncated');
}

{
  const long = 'x'.repeat(50);
  const result = truncateForContext(long, 10);
  assert(result.truncated === true && result.text.length === 10, 'text over the cap is cut to exactly maxChars');
  assert(result.meta.totalChars === 50, 'meta still reports the original, pre-truncation size');
  const banner = buildTruncationBanner(result.meta, 10);
  assert(banner.includes('10') && banner.includes('50'), 'the banner names both the shown and true total size');
}

// --- dispatchExtraction: routing by extension ---

{
  const result = await extractAttachmentText({ filename: 'todo.md', mimeType: 'text/markdown', bytes: Buffer.from('# Title\n\nbody') });
  assert(result.status === 'ok', 'a .md file routes to the plain-text track and succeeds');
  assert(
    result.markdown === '# Title\n\nbody',
    'a Markdown file is attached completely unfenced, so its own headings stay real headings once promoted to a Document',
  );
}

{
  // .txt (no language tag at all) gets the same unfenced treatment as .md — it's prose, not code.
  const result = await extractAttachmentText({ filename: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('just some notes') });
  assert(result.markdown === 'just some notes', 'a plain .txt file is also attached unfenced');
}

{
  // A real code file still gets fenced — that's the correct rendering everywhere it ends up
  // (chat, a promoted Note, or a promoted Document, which already expects fenced code blocks).
  const result = await extractAttachmentText({ filename: 'script.py', mimeType: 'text/x-python', bytes: Buffer.from('print(1)') });
  assert(result.markdown === '```python\nprint(1)\n```', 'a code file is still wrapped in a language-tagged fence');
}

{
  const result = await extractAttachmentText({ filename: 'report.docx', mimeType: 'application/vnd.openxmlformats', bytes: Buffer.from('PK...') });
  assert(result.status === 'unsupported', 'a .docx file is explicitly unsupported rather than mis-decoded as garbage text');
}

{
  const result = await extractAttachmentText({ filename: 'photo.png', mimeType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  assert(result.status === 'unsupported', 'an image file is explicitly unsupported by the text-upload route');
}

{
  // A raw content string long enough to force truncation, wrapped in a fence afterward — proves
  // the fence always closes even when the underlying text was cut (fence-after-truncate ordering).
  // Uses a code extension deliberately: prose files (.txt/.md) are never fenced at all, so this
  // needs a language-tagged file to actually exercise the fence-after-truncate ordering.
  const bigContent = 'print(1)\n'.repeat(30_000); // well over DEFAULT_ATTACHMENT_CHAR_CAP
  const result = await extractAttachmentText({ filename: 'huge.py', mimeType: 'text/x-python', bytes: Buffer.from(bigContent) });
  assert(result.status === 'ok' && result.truncated === true, 'a file over the char cap comes back truncated');
  assert(result.markdown.startsWith('```python\n') && result.markdown.endsWith('\n```'), 'truncation happens before fencing, so the closing fence is never cut off');
  assert(result.meta.totalChars === bigContent.length, 'meta reports the true pre-truncation size');
}

// --- attachmentContext: splicing onto the latest user message, never mutating input ---

{
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'see attached' },
  ];
  const frozen = JSON.parse(JSON.stringify(messages));
  const spliced = appendAttachmentsToLatestUserMessage(messages, [
    { filename: 'notes.txt', markdown: '```\nsome notes\n```' },
  ]);
  assert(JSON.stringify(messages) === JSON.stringify(frozen), 'the input messages array is never mutated');
  assert(spliced[0].content === 'hello' && spliced[1].content === 'hi there', 'earlier messages are untouched');
  assert(
    spliced[2].content.startsWith('see attached\n\nAttached file: notes.txt') && spliced[2].content.includes('some notes'),
    'the attachment is appended to the LATEST user message, not the first one',
  );
}

{
  const messages = [{ role: 'user', content: 'see attached' }];
  const spliced = appendAttachmentsToLatestUserMessage(messages, [
    { filename: 'big.txt', markdown: '```\ncut off\n```', truncated: true, meta: { totalChars: 500, totalLines: 40 } },
  ]);
  assert(spliced[0].content.includes('[truncated:'), 'a truncated attachment carries its banner into the spliced message');
}

{
  const messages = [{ role: 'user', content: 'hi' }];
  const spliced = appendAttachmentsToLatestUserMessage(messages, []);
  assert(spliced === messages, 'an empty attachments array returns the exact same array reference (no-op)');
}

// --- End to end: a real multipart POST against a real running server ---

const llm = createStubLlmProvider([{ message: { role: 'assistant', content: 'saw it' }, toolCalls: [] }]);
const db = createPostgresClient({
  async connect() {
    return {
      async query(sql) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('set_config')) return { rows: [] };
        throw new Error(`unexpected query in attachments verify: ${sql}`);
      },
      release() {},
    };
  },
});
const apiKeys = createApiKeyStore('good-key:11111111-1111-1111-1111-111111111111');
const capturedTurns = [];
const capturingLlm = {
  name: 'capturing',
  async complete(messages) {
    capturedTurns.push(messages);
    return { message: { role: 'assistant', content: 'ok' }, toolCalls: [] };
  },
};

const server = startHttpServer({
  llm: capturingLlm,
  db,
  tools: createToolRegistry([]),
  apiKeys,
  accessIdentity: { async userIdForAccessJwt() { return undefined; } },
  chats: {
    async getChat() { return undefined; },
  },
  adminApiKey: 'unused',
  credentials: { async list() { return []; } },
  settings: { async get() { return undefined; }, async set() {} },
  llmProfiles: {},
  modelName: 'bigbrain',
  port: 0,
});
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const noAuthRes = await fetch(`${base}/v1/attachments/extract`, { method: 'POST' });
assert(noAuthRes.status === 401, 'POST /v1/attachments/extract with no auth returns 401');

const form = new FormData();
form.append('file', new Blob(['console.log("hi")'], { type: 'text/javascript' }), 'app.js');
const uploadRes = await fetch(`${base}/v1/attachments/extract`, {
  method: 'POST',
  headers: { authorization: 'Bearer good-key' },
  body: form,
});
const uploadBody = await uploadRes.json();
assert(uploadRes.status === 200, 'an authenticated multipart upload returns 200');
assert(uploadBody.filename === 'app.js', 'the response echoes the uploaded filename');
assert(
  uploadBody.markdown === '```javascript\nconsole.log("hi")\n```',
  'the response carries the fenced, language-tagged Markdown for a real multipart-parsed file',
);
assert(uploadBody.truncated === false, 'a small file is not marked truncated');

const docxForm = new FormData();
docxForm.append('file', new Blob(['PK fake docx bytes']), 'resume.docx');
const docxRes = await fetch(`${base}/v1/attachments/extract`, {
  method: 'POST',
  headers: { authorization: 'Bearer good-key' },
  body: docxForm,
});
assert(docxRes.status === 422, 'a .docx upload returns 422 (explicit "not supported yet"), not a 200 with garbage text');

// A chat turn that includes `attachments` gets them spliced into what the model sees...
const chatRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: 'Bearer good-key', 'content-type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'what does this file do?' }],
    attachments: [{ filename: 'app.js', markdown: uploadBody.markdown }],
  }),
});
assert(chatRes.status === 200, 'a chat completion with attachments succeeds');
const turnSent = capturedTurns.at(-1);
const userMsg = turnSent.find((m) => m.role === 'user');
assert(
  userMsg.content.includes('what does this file do?') && userMsg.content.includes('console.log("hi")'),
  'the model actually received both the original text and the attached file content in one message',
);

// ...but a stateless request (no chat_id) obviously has nothing to persist in the first place —
// the real "never persisted" guarantee (messages vs messagesForLlm diverging) is exercised by
// verify-server.mjs's existing chat_id persistence assertions, which this script doesn't
// duplicate; this just proves the attachments field is optional and doesn't break that path.
const noAttachmentsRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: 'Bearer good-key', 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'no file this time' }] }),
});
assert(noAttachmentsRes.status === 200, 'a chat completion with no attachments field at all still works');

server.close();

if (process.exitCode) {
  console.error('\nattachments verification FAILED');
  process.exit(1);
}
console.log('\nattachments verification passed');
