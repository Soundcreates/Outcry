FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=2567

WORKDIR /app

RUN npm install --global pnpm@10.14.0

COPY package.json ./
COPY shared/package.json shared/package.json
COPY shared/src shared/src

RUN apt-get update \
    && apt-get install --yes --no-install-recommends git ca-certificates \
    && pnpm install --no-frozen-lockfile \
    && apt-get purge --yes --auto-remove git \
    && rm -rf /var/lib/apt/lists/* \
    && touch .env

COPY src src
COPY maps maps

USER node

EXPOSE 2567

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:2567/health").then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))'

CMD ["node", "--env-file=.env", "--import", "tsx", "src/index.ts"]
