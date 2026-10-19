# 云端存档 API：只带校验所需的两个核心模块，不安装前端依赖。
# 构建上下文是仓库根目录：docker build -f server/Dockerfile .
FROM node:24-alpine
WORKDIR /app

COPY package.json ./
COPY src/core/project.js src/core/datetime.js ./src/core/
COPY server/index.js ./server/

# 数据目录归 node 用户所有；首次挂载空命名卷时会继承这个属主
RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=8787 DATA_DIR=/data
EXPOSE 8787
CMD ["node", "server/index.js"]
