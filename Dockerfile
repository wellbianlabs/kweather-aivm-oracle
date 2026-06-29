# K-Weather × AIVM Oracle — self-host image (web + /api on one Node process).
FROM node:20-alpine
WORKDIR /app

# install only runtime deps (hardhat etc. are devDependencies)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# app source (web/, api/, lib/, server.js) — .dockerignore keeps secrets out
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# basic container healthcheck against the quote endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:8080/api/quote" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
