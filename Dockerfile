FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
USER node
CMD ["npm", "test"]
