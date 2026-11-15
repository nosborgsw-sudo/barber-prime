# Backend do Barber Prime (API + frontend em /).
# Sem DATABASE_URL usa o PostgreSQL embutido (PGlite) em /app/data; em produção defina DATABASE_URL.
# Credenciais (ADMIN_LOGIN/ADMIN_PASSWORD, TWILIO_*) entram só por variável de ambiente no "docker run".
FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY db ./db
COPY migrations ./migrations
COPY automation/challenge-provider.mjs ./automation/challenge-provider.mjs
COPY jobs ./jobs
COPY public ./public
COPY app-autonomo.html ./

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
