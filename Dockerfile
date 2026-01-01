# ═══════════════════════════════════════════════════════════════════════════════
# LinkedIn Easy Apply Bot - Dockerfile
# ═══════════════════════════════════════════════════════════════════════════════
# 
# Build:  docker build -t linkedin-bot .
# Run:    docker run --env-file .env --shm-size=1gb linkedin-bot
#
# For VPS deployment with persistent data:
# docker run -d --name linkedin-bot \
#   --env-file .env \
#   --shm-size=1gb \
#   -v $(pwd)/data:/app/data \
#   --restart unless-stopped \
#   linkedin-bot
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:20-slim

# Install Chrome dependencies and Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    ca-certificates \
    procps \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/*

# Set Chrome path for Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Disable Chrome crash reporting (fixes crashpad error)
ENV CHROME_CRASHPAD_DISABLE=1

# Create app directory
WORKDIR /app

# Create non-root user for security
RUN groupadd -r botuser && useradd -r -g botuser botuser

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY .env.example ./

# Create data directory with proper permissions
RUN mkdir -p data && chown -R botuser:botuser /app

# Switch to non-root user
USER botuser

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
