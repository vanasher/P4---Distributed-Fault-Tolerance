# One image for all six nodes (the view plus five services); docker-compose.yml picks which node each container runs.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
