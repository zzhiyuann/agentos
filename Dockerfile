FROM node:22-slim

WORKDIR /app

# Install tmux for local agent execution
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Copy runtime files
COPY scripts/ scripts/
COPY .env.example ./

# State directory
RUN mkdir -p /root/.aos

EXPOSE 3848

ENV NODE_ENV=production

CMD ["node", "dist/cli.js", "serve"]
