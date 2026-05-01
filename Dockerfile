# --- build stage ----------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# OpenSSL for Prisma; vips for sharp native build (only needed if sharp falls
# back to source, but harmless to include).
RUN apk add --no-cache openssl vips-dev python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npx prisma generate
RUN npm run build

# --- runtime stage --------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# vips is the runtime dep for sharp.
RUN apk add --no-cache openssl tini vips

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Uploads dir (mounted from host in production).
RUN mkdir -p /app/uploads/avatars

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
