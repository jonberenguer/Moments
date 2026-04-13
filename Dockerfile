FROM node:20-slim

RUN apt update && apt install -y \
    curl wine wine64 mono-runtime

ENV ELECTRON_VERSION=35.7.5

RUN mkdir -p ~/.cache/electron && \
    curl -L "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip" \
      -o ~/.cache/electron/electron-v${ELECTRON_VERSION}-linux-x64.zip

WORKDIR /app
COPY package*.json ./
RUN npm ci

