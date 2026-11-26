FROM node:22-bookworm-slim

ENV PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src/ ./src/
COPY docs/swagger.spec.js ./docs/swagger.spec.js

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
