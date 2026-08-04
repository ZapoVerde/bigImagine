# Builds the whole npm-workspaces monorepo (orchestrator + every plugin) into one image. Not
# optimized for layer size or a slim final stage — this is a homelab deployment of a handful of
# small packages, not a public image; correctness and simplicity win over that here.
FROM node:22-alpine
WORKDIR /app

# docs/spec.md §6.6: the documents plugin shells out to a real `git` binary (plugins/documents/src/
# gitRepo.ts) to commit into each user's own local content repo — no remote, no push, so nothing
# beyond the binary itself is needed here.
RUN apk add --no-cache git

COPY package.json package-lock.json tsconfig.base.json ./
COPY orchestrator/package.json orchestrator/package.json
COPY plugins/canonize/package.json plugins/canonize/package.json
COPY plugins/characters/package.json plugins/characters/package.json
COPY plugins/chat-memory/package.json plugins/chat-memory/package.json
COPY plugins/context-stack-presets/package.json plugins/context-stack-presets/package.json
COPY plugins/document-ingestion/package.json plugins/document-ingestion/package.json
COPY plugins/documents/package.json plugins/documents/package.json
COPY plugins/locations/package.json plugins/locations/package.json
COPY plugins/math-utils/package.json plugins/math-utils/package.json
COPY plugins/notes/package.json plugins/notes/package.json
COPY plugins/notifications/package.json plugins/notifications/package.json
COPY plugins/prompt-presets/package.json plugins/prompt-presets/package.json
COPY plugins/scenes/package.json plugins/scenes/package.json
COPY plugins/temporal/package.json plugins/temporal/package.json
COPY plugins/web/package.json plugins/web/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY orchestrator orchestrator
COPY plugins plugins
COPY frontend frontend
RUN npm run build --workspace=@bigbrain/orchestrator \
 && npm run build --workspace=@bigbrain/plugin-canonize \
 && npm run build --workspace=@bigbrain/plugin-characters \
 && npm run build --workspace=@bigbrain/plugin-chat-memory \
 && npm run build --workspace=@bigbrain/plugin-context-stack-presets \
 && npm run build --workspace=@bigbrain/plugin-document-ingestion \
 && npm run build --workspace=@bigbrain/plugin-documents \
 && npm run build --workspace=@bigbrain/plugin-locations \
 && npm run build --workspace=@bigbrain/plugin-math-utils \
 && npm run build --workspace=@bigbrain/plugin-notes \
 && npm run build --workspace=@bigbrain/plugin-notifications \
 && npm run build --workspace=@bigbrain/plugin-prompt-presets \
 && npm run build --workspace=@bigbrain/plugin-scenes \
 && npm run build --workspace=@bigbrain/plugin-temporal \
 && npm run build --workspace=@bigbrain/plugin-web \
 && npm run build --workspace=@bigbrain/frontend

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "orchestrator/dist/index.js"]
