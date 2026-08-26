FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=pwuser:pwuser src ./src

ENV NODE_ENV=production
USER pwuser

CMD ["npm", "start"]
