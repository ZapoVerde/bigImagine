Reviewed against the live repo. Three corrections from the version below:

1. **Migration number is wrong.** `0130` was already taken by `0130_chat_memory_sync_status_error_detail.sql` (committed in `f1864f7`, unrelated chat-memory work). Chunk 1's migration is **`0131_image_connections_bgrm_purpose.sql`**, not `0130`. All references below are corrected.
2. **Model placeholder ordering gotcha.** `ImageConnectionEditor.tsx`'s Model placeholder ternary is keyed only on `draft.kind` (`pollinations`/`runware`/else). Once BGRM forces `kind: 'runware'`, that ternary falls into the existing `runware` branch and shows the generation placeholder `e.g. runware:100@1`, not an RMBG-oriented one — unless `draft.purpose === 'bgrm'` is checked *first*. Called out explicitly in §6 below.
3. **Preamble requirement.** `bi_principles.md` principle 9 requires every source file to open with a structured preamble (architectural role, public API, contract, timestamp) — every comparable file in this codebase (`imageConnections.ts`, `runware.ts`, `httpRetry.ts`, `admin/imageConnections.ts`) follows this. The original draft gave `removeBackground.ts` a full contract but never said to write it as the file's opening preamble. Added explicitly in §2 below.

Also confirmed as non-issues: Base URL and Workflow Parameters are already gated on `draft.kind` (comfyui/openai-images/fal-ai, and comfyui respectively), so forcing `kind: 'runware'` for BGRM already hides them with no new purpose check needed — only Width/Height/Sampling steps/CFG scale/Sampler name/Seed/Master positive/negative prompt need the new `draft.purpose === 'bgrm'` guard, since those always render regardless of kind.

The existing image-connection **Test** button assumes every image connection is a generator, so for BGRM we disable/hide that button in this chunk rather than accidentally send an RMBG model through `imageInference`.

````md
# Chunk 1 — BGRM Connection Capability

## Goal

Add Background Removal (`bgrm`) as a first-class image connection purpose and add the standalone
Runware RMBG adapter.

At the end of this chunk:

- the Connections UI can create/edit/activate a BGRM connection;
- only one BGRM connection can be active at a time, independently of background and portrait;
- server-side code can resolve the active BGRM connection with `resolveActive('bgrm')`;
- server-side code can call Runware background removal with either:
  - a public image URL, or
  - a Runware image UUID;
- the adapter returns the final transparent Runware image URL;
- no generation pipeline uses BGRM yet;
- no image is downloaded or stored by BigImagine;
- no Studio/RP toggle exists yet;
- no generator contract changes yet.

This chunk establishes the capability only.

---

# Current repo state

Relevant current facts:

- highest migration is `0130_chat_memory_sync_status_error_detail.sql` (unrelated chat-memory work); the next free number is `0131`;
- `ImageConnectionPurpose` is currently:

```ts
'background' | 'portrait'
````

* `resolveActive(purpose)` already scopes active image connections by purpose;
* activation already deactivates only same-purpose rivals;
* the existing partial unique index is already keyed by `purpose`;
* Runware generation already has the correct REST transport:

  * `POST https://api.runware.ai/v1`
  * JSON array body
  * Bearer authentication
  * `fetchWithRetry`
  * task UUID matching;
* the Connections editor currently assumes every image connection is an image generator;
* `testImageConnection()` also assumes every image connection is a generator and dispatches through
  `createImageGenProvider()`.

Therefore BGRM must NOT be routed through the existing generator factory or generator test probe.

---

# Files

## Create

### 1. `db/migrations/0131_image_connections_bgrm_purpose.sql`

Purpose:

Widen the database purpose vocabulary from:

```text
background | portrait
```

to:

```text
background | portrait | bgrm
```

Implementation:

```sql
alter table image_connections
  drop constraint if exists image_connections_purpose_check;

alter table image_connections
  add constraint image_connections_purpose_check
  check (purpose in ('background', 'portrait', 'bgrm'));
```

Do not modify `0105_visual_studio.sql`.

Do not recreate the active-purpose index.

The existing:

```text
image_connections_one_active_per_purpose
```

already operates on `purpose`, so once `bgrm` is legal it automatically permits:

```text
1 active background
1 active portrait
1 active bgrm
```

simultaneously.

### Optional defensive DB constraint

Because BGRM v1 is Runware-only, add:

```sql
alter table image_connections
  add constraint image_connections_bgrm_runware_only
  check (purpose <> 'bgrm' or kind = 'runware');
```

This is recommended.

It prevents malformed direct API/database writes from producing:

```text
purpose = bgrm
kind = pollinations
```

or any other unsupported combination.

---

### 2. `orchestrator/src/io/imageGen/removeBackground.ts`

Purpose:

Standalone Runware background-removal IO adapter.

This file must NOT import or interact with:

```text
createImageGenProvider
ImageGenRequest
generateRunwareImage
```

BGRM is not image generation.

### Required file preamble

Per `bi_principles.md` principle 9 ("Every Module is Self-Describing"), open this file with the
same structured preamble block every comparable IO Wrapper in this codebase uses (see
`orchestrator/src/io/imageConnections.ts`, `orchestrator/src/io/imageGen/runware.ts`, or
`orchestrator/src/io/httpRetry.ts` for the exact format):

```ts
/**
 * @file orchestrator/src/io/imageGen/removeBackground.ts
 * @stamp <today's date>
 * @architectural-role IO Wrapper — standalone Runware background-removal adapter
 * @description
 * <why this file exists separately from runware.ts's generator — BGRM is not image generation>
 *
 * @api-declaration
 * removeBackground(req: RemoveBackgroundRequest) -> Promise<RemoveBackgroundResult>
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call via fetch)
 *     state_ownership: []
 *     external_io:     [https://api.runware.ai/v1]
 */
```

This is not optional boilerplate — it is how every other file in this module category documents
itself, and its absence is the kind of gap a reviewer will bounce back.

## Public contract

```ts
export interface RemoveBackgroundRequest {
  image: string;
  model: string;
  apiKey: string;
}

export interface RemoveBackgroundResult {
  imageUrl: string;
}

export async function removeBackground(
  req: RemoveBackgroundRequest,
): Promise<RemoveBackgroundResult>
```

`image` deliberately means a generic Runware-supported image reference.

Examples:

External provider:

```ts
{
  image: 'https://example.com/generated-image.jpg',
  model: 'runware:112@10',
  apiKey: '...'
}
```

Runware-generated image:

```ts
{
  image: 'runware-image-uuid',
  model: 'runware:112@10',
  apiKey: '...'
}
```

Do not distinguish between these cases in this adapter.

Runware receives the string unchanged.

## Request construction

Mirror the existing transport conventions in:

```text
orchestrator/src/io/imageGen/runware.ts
```

Use:

```ts
const taskUUID = randomUUID();

const task = {
  taskType: 'removeBackground',
  taskUUID,
  model: req.model,
  inputs: {
    image: req.image,
  },
  outputFormat: 'PNG',
};
```

POST:

```ts
JSON.stringify([task])
```

to:

```text
https://api.runware.ai/v1
```

headers:

```ts
{
  'content-type': 'application/json',
  authorization: `Bearer ${req.apiKey}`,
}
```

Use the existing:

```ts
fetchWithRetry
```

Do not add a new HTTP client.

## Response handling

Follow `runware.ts`'s existing task-response matching pattern:

1. parse `data`;
2. find the row whose `taskUUID` matches this request;
3. fall back to `rows[0]` only as the existing Runware adapter does;
4. if Runware returns `errorCode`, throw a useful error;
5. require `imageURL`;
6. return:

```ts
{
  imageUrl: taskResult.imageURL,
}
```

## Error contract

The adapter throws on:

* missing API key;
* HTTP failure;
* Runware task error;
* malformed response;
* response without `imageURL`.

Do NOT implement fail-open here.

Fail-open belongs in the orchestration helper in Chunk 2.

Suggested error prefixes:

```text
runware bgrm: no API key configured
runware bgrm: HTTP 401 — ...
runware bgrm: task error [...]
runware bgrm: response contained no imageURL
```

## Important non-goals

Do not:

* download `req.image`;
* fetch `req.image`;
* convert URLs to Base64;
* upload anything;
* store anything;
* inspect whether `req.image` is a URL or UUID;
* route through `createImageGenProvider`.

The only network request BigImagine makes is the Runware RMBG request.

---

# Edit

## 3. `orchestrator/src/io/imageConnections.ts`

Change:

```ts
export type ImageConnectionPurpose =
  | 'background'
  | 'portrait';
```

to:

```ts
export type ImageConnectionPurpose =
  | 'background'
  | 'portrait'
  | 'bgrm';
```

Update nearby comments that currently describe the purpose vocabulary as only background/portrait.

Do not change:

```ts
ImageConnectionKind
```

There must NOT be a new:

```text
'bgrm'
```

kind.

BGRM remains:

```text
kind = 'runware'
purpose = 'bgrm'
```

No store query changes should be necessary.

Specifically leave the existing behaviour of:

```ts
resolveActive(purpose?)
activate(id)
create()
update()
list()
remove()
resolveById()
```

alone unless a test exposes an actual problem.

The existing purpose-scoped activation logic should work automatically.

---

## 4. `orchestrator/src/server/admin/imageConnections.ts`

### Purpose parsing

Change:

```ts
function isImagePurpose(value: unknown): value is ImageConnectionPurpose {
  return value === 'background' || value === 'portrait';
}
```

to accept:

```text
bgrm
```

as well.

### BGRM provider validation

On CREATE, reject:

```text
purpose = bgrm
kind != runware
```

The parser has both values available, so enforce this directly.

Conceptually:

```ts
if (purpose === 'bgrm' && kind !== 'runware') {
  return undefined;
}
```

On PATCH, reject an explicitly contradictory pair:

```text
purpose = bgrm
kind = anything except runware
```

The UI save currently sends both `kind` and `purpose`, so the normal admin path is covered.

The migration's DB constraint remains the final safety net for partial/direct PATCH requests.

### Existing image Test probe

Do NOT modify `testImageConnection()` into a BGRM probe in this chunk.

It currently does:

```text
resolve connection
→ synthesize generation prompt
→ createImageGenProvider(profile)
→ generate()
```

That is incorrect for a `bgrm` connection.

The frontend will disable the Test action for `purpose === 'bgrm'` in this chunk.

A proper BGRM connection probe can be added later if wanted, but it is not required to establish
the capability.

Do not invent a permanent sample image URL just to make the existing Test button work.

---

## 5. `frontend/src/api/types.ts`

The current frontend duplicates the server purpose union manually.

Update all image-connection purpose declarations.

### `ImageConnectionSummary`

Change:

```ts
purpose: 'background' | 'portrait';
```

to:

```ts
purpose: 'background' | 'portrait' | 'bgrm';
```

### `CreateImageConnectionInput`

Change:

```ts
purpose?: 'background' | 'portrait';
```

to:

```ts
purpose?: 'background' | 'portrait' | 'bgrm';
```

### `UpdateImageConnectionInput`

Change:

```ts
purpose?: 'background' | 'portrait';
```

to:

```ts
purpose?: 'background' | 'portrait' | 'bgrm';
```

Update the associated comments.

Do not introduce a separate frontend BGRM connection type.

---

## 6. `frontend/src/components/connections/ImageConnectionEditor.tsx`

This is the main UI change.

### Add the new purpose

Extend Purpose:

```tsx
<option value="background">
  Background — location renders
</option>

<option value="portrait">
  Portrait — Portrait Studio candidates
</option>

<option value="bgrm">
  Background removal
</option>
```

### Force Runware when BGRM is selected

When the user changes Purpose to:

```text
bgrm
```

also set:

```ts
kind: 'runware'
```

Do this in the purpose `onChange`, not with a side-effect.

Example behaviour:

```text
Purpose = Portrait
Kind = fal-ai

user selects Background removal

Purpose = bgrm
Kind = runware
```

### Lock provider selection

When:

```ts
draft.purpose === 'bgrm'
```

the Kind selector must not allow another provider.

Simplest implementation:

```tsx
disabled={draft.purpose === 'bgrm'}
```

with its value already forced to `runware`.

Do not add BGRM as a Kind option.

### Model

Keep Model visible.

For BGRM, use an RMBG-oriented placeholder such as:

```text
e.g. runware:112@10
```

**Implementation note:** the current placeholder is a ternary keyed on `draft.kind` alone
(`pollinations` → `'e.g. flux'`, `runware` → `'e.g. runware:100@1'`, else fal.ai's). Since BGRM
forces `kind: 'runware'`, that ternary will fall into the existing `runware` branch and show the
*generation* placeholder unless `draft.purpose === 'bgrm'` is checked first, e.g.:

```tsx
placeholder={
  draft.purpose === 'bgrm'
    ? 'e.g. runware:112@10'
    : draft.kind === 'pollinations'
      ? 'e.g. flux'
      : draft.kind === 'runware'
        ? 'e.g. runware:100@1'
        : 'e.g. fal-ai/z-image/turbo'
}
```

Do not hardcode the model into application logic.

The connection row owns the chosen RMBG model exactly like other image connections own their model.

### API key

Keep API key visible.

BGRM requires a Runware API key.

### Hide generation-only controls

When:

```ts
draft.purpose === 'bgrm'
```

hide these controls:

```text
Base URL
Width
Height
Sampling steps
CFG scale
Sampler name
Seed
Master positive style prefix
Master negative prompt
Workflow parameters
```

They are generator configuration and have no meaning to RMBG.

**Implementation note:** Base URL and Workflow parameters are already gated on `draft.kind`
(`comfyui`/`openai-images`/`fal-ai`, and `comfyui` only, respectively) — since BGRM forces
`kind: 'runware'`, those two already hide automatically with no new check needed. Only Width,
Height, Sampling steps, CFG scale, Sampler name, Seed, Master positive style prefix, and Master
negative prompt render unconditionally today and need the new `draft.purpose === 'bgrm'` guard.

Do NOT delete these fields from the database schema.

A BGRM row will still receive the table defaults for required generation columns; they are simply
irrelevant and unused.

### Save behaviour

Do not build an entirely separate save path.

Continue using:

```text
adminCreateImageConnection
adminUpdateImageConnection
```

For BGRM rows send the required meaningful fields:

```ts
name
kind: 'runware'
purpose: 'bgrm'
model
apiKey when supplied
```

It is acceptable for the existing create/update helper to continue supplying harmless default
generation fields if avoiding that requires invasive branching.

The important contract is that BGRM never reads those values.

### Test button

The existing Test button generates an image.

For:

```ts
draft.purpose === 'bgrm'
```

disable or hide it.

Preferred:

```text
hide it
```

because "Test" currently means "generate a test image", which is conceptually wrong for BGRM.

Do not alter the server generator-test endpoint in this chunk.

### Activation

Leave Set as default / Active behaviour unchanged.

For BGRM it means:

```text
active BGRM connection
```

not active generator.

---

## 7. `frontend/src/views/ConnectionsView.tsx`

Update the active-purpose badge.

Current logic is effectively:

```tsx
portrait ? '(prt)' : '(bg)'
```

which would incorrectly render BGRM as `(bg)`.

Replace the binary expression with all three cases.

Expected labels:

```text
background → (bg)
portrait   → (prt)
bgrm       → (brm)
```

Expected titles:

```text
active — Background image connection
active — Portrait image connection
active — Background removal connection
```

Keep the existing visual badge styling.

Do not create a new connection section.

BGRM remains under Image connections.

---

# Verification

## 8. `orchestrator/scripts/verify-image-connections.mjs`

Extend the existing verification script rather than creating another large test harness.

It already covers:

* image connection CRUD;
* purpose-scoped activation;
* Runware wire shape;
* image connection resolution.

Add Chunk 1 coverage here.

### A. Purpose persistence

Create:

```ts
const bgrm = await imageConnections.create({
  name: 'runware-bgrm',
  kind: 'runware',
  purpose: 'bgrm',
  model: 'runware:112@10',
  apiKey: 'sk-rmbg-test',
});
```

Assert:

```text
bgrm.purpose === 'bgrm'
```

Resolve:

```ts
await imageConnections.resolveActive('bgrm')
```

after activation and assert its:

```text
kind === runware
purpose === bgrm
model === configured model
apiKey decrypts correctly
```

### B. Independent activation

Create/activate:

```text
background connection
portrait connection
BGRM connection A
BGRM connection B
```

Prove:

```text
activating BGRM A:
  background remains active
  portrait remains active

activating BGRM B:
  BGRM A becomes inactive
  BGRM B becomes active
  background remains active
  portrait remains active
```

This pins the existing index/store behaviour for the third purpose.

### C. Runware BGRM URL input

Import:

```ts
removeBackground
```

from the built adapter.

Mock `fetch`.

Call:

```ts
await removeBackground({
  image: 'https://example.test/generated.jpg',
  model: 'runware:112@10',
  apiKey: 'test-key',
});
```

Capture the outgoing request.

Assert:

```text
POST URL === https://api.runware.ai/v1

Authorization === Bearer test-key

body is an array of length 1

task.taskType === removeBackground

task.model === runware:112@10

task.inputs.image === https://example.test/generated.jpg

task.outputFormat === PNG
```

Return a mocked successful Runware response containing:

```text
matching taskUUID
imageURL = https://runware.test/transparent.png
```

Assert:

```ts
result.imageUrl === 'https://runware.test/transparent.png'
```

Critically, assert there is only one mocked fetch call.

This proves BigImagine did not separately fetch the source image.

### D. Runware UUID input

Call the same function with:

```ts
image: '11111111-2222-3333-4444-555555555555'
```

Assert the exact UUID appears unchanged at:

```ts
task.inputs.image
```

No URL conversion.

No additional fetch.

### E. Error handling

Add cases for:

1. missing/blank API key;
2. HTTP non-2xx;
3. Runware task-level `errorCode`;
4. successful HTTP response with no `imageURL`.

Assert each throws.

Do NOT test fail-open here.

Fail-open does not exist until Chunk 2.

---

# Build / static verification

Run:

```bash
npm run check
```

This matters because the purpose union exists independently in server and frontend TypeScript.

Then run:

```bash
npm run build
```

Then:

```bash
node orchestrator/scripts/verify-image-connections.mjs
```

Or the repository's full:

```bash
npm run verify
```

if practical.

No live Runware call is required for automated verification.

The adapter wire contract should be tested using mocked `fetch`.

---

# Explicitly untouched files

Do NOT modify these in Chunk 1:

```text
orchestrator/src/io/imageGen/index.ts
orchestrator/src/io/imageGen/types.ts
orchestrator/src/io/imageGen/runware.ts
orchestrator/src/orchestrator/generateLocationImage.ts
orchestrator/src/orchestrator/portraitGeneration.ts
orchestrator/src/server/portraitRoutes.ts
frontend/src/views/ChatView.tsx
frontend/src/components/sidebar/*
```

In particular:

### Do not modify `imageGen/types.ts`

The generator still returns its existing shape.

The optional Runware `imageUUID` support belongs to Chunk 2.

### Do not modify `runware.ts`

Do not combine generation and background removal.

The existing Runware generator remains exactly a generator.

### Do not touch image persistence

No existing location, portrait candidate, character image, cache or swipe URL should pass through
BGRM yet.

---

# Expected file diff

## New

```text
db/migrations/0131_image_connections_bgrm_purpose.sql
orchestrator/src/io/imageGen/removeBackground.ts
```

## Modified

```text
orchestrator/src/io/imageConnections.ts
orchestrator/src/server/admin/imageConnections.ts
orchestrator/scripts/verify-image-connections.mjs
frontend/src/api/types.ts
frontend/src/components/connections/ImageConnectionEditor.tsx
frontend/src/views/ConnectionsView.tsx
```

Total:

```text
2 new files
6 modified files
```

No other production files should be necessary.

---

# Acceptance criteria

Chunk 1 is complete when all of these are true:

1. The DB accepts:

```text
purpose = bgrm
kind = runware
```

2. The DB/server rejects unsupported BGRM provider combinations.

3. Connections UI can create a BGRM connection.

4. Selecting BGRM automatically selects and locks Runware.

5. Generator-only settings are not shown for a BGRM connection.

6. A BGRM connection can be independently activated.

7. Background, Portrait and BGRM connections can all be active simultaneously.

8. `resolveActive('bgrm')` returns the active decrypted Runware profile.

9. `removeBackground()` accepts an external image URL unchanged.

10. `removeBackground()` accepts a Runware image UUID unchanged.

11. `removeBackground()` sends:

```text
taskType = removeBackground
inputs.image = supplied reference
outputFormat = PNG
```

12. `removeBackground()` returns Runware's resulting `imageURL`.

13. BigImagine never downloads the source image.

14. BGRM is never passed through `createImageGenProvider()`.

15. No generation pipeline invokes BGRM yet.

16. Existing background and portrait image-generation verification remains green.

---

# End state

After this chunk the architecture is:

```
                                  ┌────────────────────┐
                                  │ active bgrm conn   │
                                  │ Runware + model    │
                                  └─────────┬──────────┘
                                            │
                                            ▼
```

image reference ──────────────────────► removeBackground()
│
▼
transparent image URL

Nothing feeds that `image reference` from a real generation pipeline yet.

That is Chunk 2's job.
