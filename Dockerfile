# Builds the whole npm-workspaces monorepo (orchestrator + every plugin) into one image. Not
# optimized for layer size or a slim final stage — this is a homelab deployment of a handful of
# small packages, not a public image; correctness and simplicity win over that here.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY orchestrator/package.json orchestrator/package.json
COPY plugins/document-ingestion/package.json plugins/document-ingestion/package.json
COPY plugins/shopping-analytics/package.json plugins/shopping-analytics/package.json
COPY plugins/lists/package.json plugins/lists/package.json
COPY plugins/recipes/package.json plugins/recipes/package.json
RUN npm ci

COPY orchestrator orchestrator
COPY plugins plugins
RUN npm run build --workspace=@bigbrain/orchestrator \
 && npm run build --workspace=@bigbrain/plugin-document-ingestion \
 && npm run build --workspace=@bigbrain/plugin-shopping-analytics \
 && npm run build --workspace=@bigbrain/plugin-lists \
 && npm run build --workspace=@bigbrain/plugin-recipes

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "orchestrator/dist/index.js"]
