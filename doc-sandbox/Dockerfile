# doc-sandbox: an isolated, internal-only conversion service for untrusted document uploads
# (docx/odt/rtf via headless LibreOffice, scanned-PDF OCR via poppler + Tesseract). Deliberately a
# separate image from the main orchestrator (Dockerfile at the repo root) rather than adding this
# heavyweight, historically CVE-prone toolchain to a shared process — see docker-compose.yml's own
# comment on this service for the full reasoning. Debian slim, not Alpine: LibreOffice and
# musl-libc are a poor pairing, and this container isn't sharing anything else's base image.
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    libreoffice-writer \
    poppler-utils \
    tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src src
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "dist/index.js"]
