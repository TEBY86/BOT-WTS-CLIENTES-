FROM node:18-slim

# Instalar Chromium y TODAS las dependencias necesarias
RUN apt-get update && apt-get install -y \
    chromium \
    libglib2.0-0 \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libx11-xcb1 \
    libxcb1 \
    libxshmfence1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Configurar Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copiar y instalar dependencias
COPY package*.json ./
RUN npm install --production

# Copiar el resto del c?digo
COPY . .

# Crear directorios necesarios
RUN mkdir -p public .wwebjs_auth .wwebjs_cache

EXPOSE 3000

# Iniciar la aplicaci?n
CMD ["node", "bot.js"]
