# Small production image for Cloud Run.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Source files can arrive owner-only (e.g. mode 600 from an external drive).
# Make everything readable so the non-root "node" user can load it.
RUN chmod -R a+rX /app

# Cloud Run sets PORT (8080 by default).
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "src/server.js"]
