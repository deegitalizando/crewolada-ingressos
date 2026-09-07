FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3100
EXPOSE 3100
CMD ["node", "src/server.js"]
