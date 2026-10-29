FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 3000

CMD ["node", "dist/server.js"]
