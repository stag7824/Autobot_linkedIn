# ═══════════════════════════════════════════════════════════════════════════════
# LinkedIn Easy Apply Bot - Dockerfile
# ═══════════════════════════════════════════════════════════════════════════════
# 
# Build:  docker build -t linkedin-bot .
# Test:   docker run --rm -it --shm-size=1gb linkedin-bot
# Run:    docker run -d --name linkedin-bot --shm-size=1gb -v $(pwd)/data:/app/data --env-file .env --restart unless-stopped linkedin-bot
# ═══════════════════════════════════════════════════════════════════════════════

# Use the official Puppeteer image (includes Chrome and all dependencies)
FROM ghcr.io/puppeteer/puppeteer:23.11.1

# Switch to root for setup
USER root

# Set environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV CHROME_CRASHPAD_DISABLE=1
ENV DISABLE_CRASHPAD=1
ENV NODE_ENV=production
ENV HEADLESS=true
# Fix chrome_crashpad_handler error (Chrome 128+)
ENV XDG_CONFIG_HOME=/tmp/.chromium
ENV XDG_CACHE_HOME=/tmp/.chromium

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY .env.example ./

# Create data directory with proper permissions
RUN mkdir -p data && chown -R pptruser:pptruser /app

# Switch to non-root user (pptruser is created by the puppeteer image)
USER pptruser

# Expose web dashboard port
EXPOSE 3000

# Health check using web dashboard
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))" || exit 1

# Run the bot
CMD ["node", "src/index.js"]
