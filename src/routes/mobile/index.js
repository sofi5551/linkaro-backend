const express = require("express");
const authRoutes = require("./auth.routes");
const jobsRoutes = require("./jobs.routes");
const userRoutes = require("./user.routes");
const servicesRoutes = require("./services.routes");
const ticketsRoutes = require("./tickets.routes");
const chatRoutes = require("./chat.routes");
const { migrateRegistrationStatus } = require("../../controllers/mobile/migration.controller");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/jobs", jobsRoutes);
router.use("/user", userRoutes);
router.use("/services", servicesRoutes);
router.use("/tickets", ticketsRoutes);
router.use("/chat", chatRoutes);
router.post("/migrate-registration-status", migrateRegistrationStatus);

module.exports = router;
