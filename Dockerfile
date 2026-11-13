FROM node:22-bookworm-slim

ENV PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY src/ ./src/
COPY docs/swagger.spec.js ./docs/swagger.spec.js
COPY test/db.test.config.js ./test/db.test.config.js

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
