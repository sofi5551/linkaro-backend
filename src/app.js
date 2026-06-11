const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const routes = require("./routes");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const env = require("./config/env");

const app = express();

if (env.nodeEnv !== "production") {
  app.use(morgan("dev"));
}

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.get("/", (req, res) => {
  res.json({ name: "linkaro-backend" });
});

app.use("/", routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
