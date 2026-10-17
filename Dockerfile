FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app
COPY package.json package.json
RUN npm install --ignore-scripts
COPY . .

EXPOSE 8088
CMD ["node", "server.js"]
