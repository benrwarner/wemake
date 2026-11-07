FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends flac && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
