FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production CANVAS_MCP_PORT=7341 CANVAS_MCP_HOST=0.0.0.0
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 7341
HEALTHCHECK CMD wget -qO- http://127.0.0.1:7341/health || exit 1
CMD ["node", "dist/index.js", "--http"]
