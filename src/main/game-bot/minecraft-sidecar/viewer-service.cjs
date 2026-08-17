"use strict";

const EventEmitter = require("node:events");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");
const { WorldView } = require("prismarine-viewer/viewer/lib/worldView");
const { setupRoutes } = require("prismarine-viewer/lib/common");
const { getVersion } = require("prismarine-viewer/viewer/lib/version");
const { createStateIdMapper, remapViewerEvent } = require("./viewer-compat.cjs");

function startThirdPersonViewer(bot, options = {}) {
  const viewDistance = Math.max(2, Math.min(8, Number(options.viewDistance) || 4));
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  setupRoutes(app, "");
  const sockets = [];
  bot.viewer = new EventEmitter();
  const viewerVersion = getVersion(bot.version);
  if (!viewerVersion) throw new Error(`prismarine-viewer 不支持 Minecraft ${bot.version}`);
  const mapStateId = createStateIdMapper(bot.version, viewerVersion);

  io.on("connection", (socket) => {
    socket.emit("version", viewerVersion);
    sockets.push(socket);
    const viewerEmitter = {
      on: socket.on.bind(socket),
      emit(event, payload) { return socket.emit(event, remapViewerEvent(event, payload, mapStateId)); },
    };
    const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, viewerEmitter);
    worldView.init(bot.entity.position);
    const emitPosition = () => {
      socket.emit("position", { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true });
      worldView.updatePosition(bot.entity.position);
    };
    bot.on("move", emitPosition);
    worldView.listenToBot(bot);
    emitPosition();
    socket.on("disconnect", () => {
      bot.removeListener("move", emitPosition);
      worldView.removeListenersFromBot(bot);
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close() {
          for (const socket of sockets) socket.disconnect(true);
          io.close();
          server.close();
        },
      });
    });
  });
}

module.exports = { startThirdPersonViewer };
