# Fraud-monitor worker image. Node 20 + @stellar/stellar-sdk. Testnet only.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY monitor.js ./
CMD ["node", "monitor.js"]
