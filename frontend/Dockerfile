FROM node:20-alpine AS build

WORKDIR /app

COPY package.json .
RUN npm install

COPY vite.config.js .
COPY index.html .
COPY src/ ./src/

RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
