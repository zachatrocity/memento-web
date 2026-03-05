# Multi-stage build for smaller image
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
# Remove postinstall temporarily to avoid frontend cd error
RUN npm pkg delete scripts.postinstall && npm install

# Copy source and build
COPY . .
RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Install ffmpeg and curl for healthcheck
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    libvips \
    && rm -rf /var/lib/apt/lists/*

# Copy built app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/frontend ./frontend

# Create data directories
RUN mkdir -p /app/data/output /app/data/uploads /music

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the app
CMD ["node", "dist/server.js"]
