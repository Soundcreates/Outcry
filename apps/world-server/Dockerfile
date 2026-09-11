# Build from the repository root:
# docker build -f apps/world-server/Dockerfile .
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=2567

WORKDIR /app

RUN npm install --global pnpm@10.14.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/world-server/package.json apps/world-server/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile \
    && touch .env

COPY apps/world-server/src apps/world-server/src
COPY packages/shared/src packages/shared/src
COPY maps maps

USER node

EXPOSE 2567

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:2567/health").then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))'

CMD ["pnpm", "--filter", "@outcry/world-server", "start"]
