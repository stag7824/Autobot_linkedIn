# ═══════════════════════════════════════════════════════════════════════════════
# LinkedIn Easy Apply Bot - Dockerfile
# ═══════════════════════════════════════════════════════════════════════════════
# 
# Build:  docker build -t linkedin-bot .
# Run:    docker run --env-file .env linkedin-bot
#
# For VPS deployment with persistent data:
# docker run -d --name linkedin-bot \
#   --env-file .env \
#   -v $(pwd)/data:/app/data \
#   --restart unless-stopped \
#   linkedin-bot
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:20-slim

# Install Chrome dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome path for Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Create app directory
WORKDIR /app

# Create non-root user for security
RUN groupadd -r botuser && useradd -r -g botuser botuser

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY .env.example ./

# Create data directory
# RUN mkdir -p data && chown -R botuser:botuser /app

# Switch to non-root user
# USER botuser

# Force headless mode in container
ENV HEADLESS=true
ENV NODE_ENV=production

# Expose web dashboard port
EXPOSE 3000

# Health check using web dashboard
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))" || exit 1

# Run the bot
CMD ["node", "src/index.js"]
