# Auto-disburser worker image. Node 20 + @stellar/stellar-sdk. Testnet only.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY watch.js ./
CMD ["node", "watch.js"]
