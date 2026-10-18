"use strict";

const { createServer } = require("./server.js");

// Vercel's Node runtime exposes the same request/response primitives as the
// built-in HTTP server, so reuse the tested routing and validation layer.
module.exports = function vercelHandler(req, res) {
  const server = createServer();
  server.emit("request", req, res);
};
