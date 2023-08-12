FROM node:16.20.1-alpine

ENV HOME=/home
ENV TS_NODE_TRANSPILE_ONLY=1
ENV TZ=Asia/Kuala_Lumpur

RUN apk --no-cache update \
  && apk --no-cache upgrade \
  && apk add --update --no-cache tzdata \
  && npm install -g nodemon

EXPOSE 3000

COPY package*.json $HOME/api/

WORKDIR $HOME/api

RUN npm install \
  && npm cache clean --force
