FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY distribuido/web ./distribuido/web
RUN npm run build && npm run build:web && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/distribuido/web/dist ./web
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
