FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
ENV DATA_DIR=/app/data
HEALTHCHECK --interval=30s --timeout=5s CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "src/index.js"]
