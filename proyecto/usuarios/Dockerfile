FROM node:24-alpine AS compilacion
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=compilacion /app/node_modules ./node_modules
COPY --from=compilacion /app/dist ./dist
COPY package*.json ./
USER node
EXPOSE 3000
# El esquema se crea en cada réplica al primer contacto (ver src/quorum.ts); no hay migración separada.
CMD ["npm", "start"]
