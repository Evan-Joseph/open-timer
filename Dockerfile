FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY . .
RUN npm run build -w web

ENV NODE_ENV=production
ENV CLOCK_PORT=4517
ENV CLOCK_DATA_DIR=/data
EXPOSE 4517
CMD ["npm", "run", "start", "-w", "server"]
