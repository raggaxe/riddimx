FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.mjs listen.html remote.html phone-bridge.js ./
USER node
CMD ["node", "index.mjs"]
