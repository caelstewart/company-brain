FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/

RUN npm install --workspaces

COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/

RUN npx turbo build

EXPOSE 3333

CMD ["node", "packages/server/dist/index.js", "--rest"]
