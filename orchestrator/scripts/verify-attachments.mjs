// Proves the file-upload/attachment pipeline end to end: pure extraction/truncation/splicing
// logic, then a real multipart POST against a real running httpServer instance (real Busboy
// parsing, not a fake), and that an attachment reaches the model for one turn without ever being
// persisted to chat history.

import { extractPlainText } from '../dist/io/attachments/extractPlainText.js';
import { extractPdfText } from '../dist/io/attachments/extractPdfText.js';
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

// A minimal, hand-built single-page PDF with a real xref table (byte offsets computed as the
// file is assembled, not hardcoded) — real enough for pdf.js to parse without triggering its
// xref-recovery fallback, which is what actual malformed/corrupted PDFs would exercise instead.
// An empty `text` produces a page with no text-showing operator at all (a stand-in for a
// scanned/image-only page, which likewise has no text layer for pdf.js to find).
//
// MediaBox width is sized to the text (18pt Helvetica, ~11pt average advance — generous, not
// exact) rather than a fixed page size: pdf.js's content-stream interpreter stops extracting a
// single Tj run once its glyph positions run past the page's own MediaBox, which a real document
// never does (real authoring tools wrap text within their page bounds) — a fixed narrow page here
// would silently truncate the fixture's own text and produce a false test failure, not a real bug.
function buildMinimalTextPdf(text) {
  const mediaBoxWidth = Math.max(300, text.length * 11 + 40);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 ${mediaBoxWidth} 300] /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const streamContent = text ? `BT /F1 18 Tf 20 250 Td (${text}) Tj ET` : 'BT ET';
  objects.push(`<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`);

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
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

// --- extractPdfText: real PDF parsing via pdfjs-dist ---

{
  const result = await extractPdfText(buildMinimalTextPdf('Hello World'));
  assert(result.hasTextLayer === false, 'sanity check on the fixture itself: "Hello World" alone is below the meaningful-chars floor');
  assert(result.text === 'Hello World', 'text is extracted verbatim from a real PDF text layer');
}

{
  const longText = 'This is a real paragraph of extracted PDF body text, well past the floor.';
  const result = await extractPdfText(buildMinimalTextPdf(longText));
  assert(result.hasTextLayer === true, 'a PDF with a substantial text layer is recognized as having one');
}

{
  const result = await extractPdfText(buildMinimalTextPdf(''));
  assert(result.hasTextLayer === false && result.text === '', 'a page with no text-showing operator at all (stand-in for a scanned page) has no text layer');
}

{
  let threw = false;
  try {
    await extractPdfText(Buffer.from('not a pdf at all'));
  } catch {
    threw = true;
  }
  assert(threw, 'garbage bytes with no PDF structure at all make extractPdfText reject, rather than silently returning empty text');
}

// --- dispatchExtraction: routing by extension ---

{
  const longText = 'This document has a real, substantial text layer well past the meaningful-chars floor.';
  const result = await extractAttachmentText({
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    bytes: buildMinimalTextPdf(longText),
  });
  assert(result.status === 'ok', 'a PDF with a real text layer is extracted successfully');
  assert(result.markdown === longText, 'extracted PDF text is attached unfenced, as prose, same as .txt/.md');
}

{
  const result = await extractAttachmentText({
    filename: 'broken.pdf',
    mimeType: 'application/pdf',
    bytes: Buffer.from('not actually a pdf'),
  });
  assert(
    result.status === 'unsupported' && result.reason.includes("couldn't be read"),
    'a corrupted/non-PDF file with a .pdf extension gets an honest "could not be read" instead of a crash',
  );
}

// --- doc-sandbox-backed branches (rich documents, scanned-PDF OCR): mocked fetch, no live
// container needed to run this script — matching this repo's own convention (verify-server.mjs
// mocks fetch the same way for Google's OAuth endpoint and OpenRouter's /models). The actual
// soffice/pdftoppm/tesseract behavior (real filter names, --infilter argv shape, the
// silently-accepts-garbage-without-it bug, the <style>-leak-into-Markdown bug) was verified by
// hand against a real built doc-sandbox image and real fixture files — that's not something a
// mocked unit test can catch, so it isn't pretended to be covered here.
{
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.BIGBRAIN_DOC_SANDBOX_URL;
  process.env.BIGBRAIN_DOC_SANDBOX_URL = 'http://fake-doc-sandbox.invalid';

  try {
    globalThis.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/convert-office' && u.searchParams.get('ext') === 'docx') {
        return new Response('<html><head><style>p{color:red}</style></head><body><h1>Title</h1><p>Body text.</p></body></html>', { status: 200 });
      }
      if (u.pathname === '/convert-office' && u.searchParams.get('ext') === 'odt') {
        return new Response(JSON.stringify({ error: 'conversion failed' }), { status: 422 });
      }
      if (u.pathname === '/ocr-pdf') {
        return new Response('Recognized text from a scanned page.', { status: 200 });
      }
      if (u.pathname === '/convert-office' && u.searchParams.get('ext') === 'rtf') {
        throw new TypeError('fetch failed'); // simulates the sandbox container being unreachable
      }
      return originalFetch(url, init);
    };

    const docxResult = await extractAttachmentText({ filename: 'report.docx', mimeType: 'x', bytes: Buffer.from('fake docx bytes') });
    assert(docxResult.status === 'ok', 'a docx converts successfully via doc-sandbox');
    assert(
      docxResult.markdown === '### Title\n\nBody text.',
      'the converted HTML runs through the shared Turndown pipeline — headings normalized to H3, <style> text stripped, unfenced as prose',
    );

    const odtResult = await extractAttachmentText({ filename: 'report.odt', mimeType: 'x', bytes: Buffer.from('fake odt bytes') });
    assert(
      odtResult.status === 'unsupported' && odtResult.reason.includes('odt'),
      'doc-sandbox reporting a conversion failure (a corrupted/password-protected file) becomes an honest unsupported result, not a crash',
    );

    const rtfResult = await extractAttachmentText({ filename: 'report.rtf', mimeType: 'x', bytes: Buffer.from('fake rtf bytes') });
    assert(
      rtfResult.status === 'unsupported',
      'doc-sandbox being unreachable (network failure) also becomes an honest unsupported result, not an unhandled rejection',
    );

    const ocrResult = await extractAttachmentText({
      filename: 'scanned.pdf',
      mimeType: 'application/pdf',
      bytes: buildMinimalTextPdf(''),
    });
    assert(ocrResult.status === 'ok', 'a PDF with no text layer routes to doc-sandbox OCR and succeeds');
    assert(ocrResult.markdown === 'Recognized text from a scanned page.', "the OCR'd text is attached unfenced, as prose");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.BIGBRAIN_DOC_SANDBOX_URL;
    else process.env.BIGBRAIN_DOC_SANDBOX_URL = originalUrl;
  }
}

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
  // With no BIGBRAIN_DOC_SANDBOX_URL configured (the state everywhere else in this script outside
  // the mocked-fetch block above), a docx correctly fails honestly rather than hanging or crashing
  // — docx success/failure behavior *with* a sandbox configured is covered by the mocked block above.
  const result = await extractAttachmentText({ filename: 'report.docx', mimeType: 'application/vnd.openxmlformats', bytes: Buffer.from('PK...') });
  assert(result.status === 'unsupported', 'a .docx file with no doc-sandbox configured fails honestly rather than hanging or mis-decoding as garbage text');
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
assert(docxRes.status === 422, 'a .docx upload with no doc-sandbox configured returns 422, not a 200 with garbage text');

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
