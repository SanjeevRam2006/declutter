"use strict";

const { createServer } = require("./server.js");
const { handleSupabase } = require("./supabase-handler.js");

// Vercel's Node runtime exposes the same request/response primitives as the
// built-in HTTP server, so reuse the tested routing and validation layer.
module.exports = function vercelHandler(req, res) {
  const supabase = handleSupabase(req, res);
  if (supabase && typeof supabase.then === "function") {
    return supabase.then((handled) => {
      if (handled) return;
      return runLocalServer(req, res);
    });
  }
  if (supabase) return supabase;
  return runLocalServer(req, res);
};

function runLocalServer(req, res) {
  const server = createServer();
  // The existing local handler is async. Keep the Vercel invocation alive
  // until the response has actually been written; returning immediately
  // can produce FUNCTION_INVOCATION_FAILED before fs/provider work finishes.
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res.once("finish", finish);
    res.once("close", finish);
    try {
      server.emit("request", req, res);
    } catch (error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}
