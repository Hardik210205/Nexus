FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY database.js migrate-sqlite-to-postgres.js nsp-server.js server.js ./

ENV NODE_ENV=production
ENV HTTP_HOST=0.0.0.0
ENV HTTP_ALLOW_REMOTE=1
ENV NEXUS_NSP_HOST=0.0.0.0
ENV NEXUS_NSP_ALLOW_REMOTE=1

EXPOSE 3000 3443

USER node
CMD ["node", "server.js"]
