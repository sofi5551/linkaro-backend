const http = require("http");
const app = require("./src/app");
const env = require("./src/config/env");
const { getClientPromise } = require("./src/config/db");
const { initSocket } = require("./src/sockets");

async function start() {
  await getClientPromise();
  console.log("Connected to MongoDB");

  const server = http.createServer(app);
  const io = initSocket(server);
  app.set("io", io);

  server.listen(env.port, () => {
    console.log(`Linkaro backend listening on port ${env.port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
