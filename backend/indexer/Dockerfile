# Stage 1: Build inside container (per project rule: no npm/node/tsc on the host)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src/ ./src
RUN npm run build

# Stage 2: Runtime image
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/indexer.js"]
