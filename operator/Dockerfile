FROM node:24-alpine
WORKDIR /app
RUN corepack enable && chown node:node /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages packages
COPY --chown=node:node operator operator
USER node
RUN pnpm install --frozen-lockfile --filter @cpn/operator --filter @cpn/core
CMD ["pnpm", "--dir", "operator", "exec", "tsx", "src/main.ts"]
