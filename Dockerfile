FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y chromium fonts-liberation libnss3 libx11-6 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 libxrandr2 libxss1 libgtk-3-0 && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p public .wwebjs_auth .wwebjs_cache
EXPOSE 3000
CMD ["node", "bot.js"]
