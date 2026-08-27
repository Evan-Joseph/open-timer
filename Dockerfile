FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu python3 make g++ sqlite3 \
  && groupadd --system opentimer \
  && useradd --system --gid opentimer --home-dir /nonexistent --shell /usr/sbin/nologin opentimer \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY . .
RUN chmod +x /app/scripts/docker-entrypoint.sh
RUN npm run build -w web

ENV NODE_ENV=production
ENV CLOCK_PORT=4517
ENV CLOCK_DATA_DIR=/data
EXPOSE 4517
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["npm", "run", "start", "-w", "server"]
