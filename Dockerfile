# Railway builds this automatically. Node 22 includes the built-in SQLite module the app uses.
FROM node:22.20.0-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
