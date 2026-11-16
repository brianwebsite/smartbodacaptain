FROM node:22-slim
WORKDIR /app
COPY backend/ ./backend/
COPY admin/ ./admin/
WORKDIR /app/backend
ENV PORT=8080 DB_PATH=/data/smartboda.db NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
