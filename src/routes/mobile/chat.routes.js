const express = require("express");
const { verifyMobileToken } = require("../../middleware/mobileAuth");
const {
  startConversation,
  getConversations,
  getMessages,
  sendMessage,
} = require("../../controllers/mobile/chat.controller");

const router = express.Router();

router.post("/start", verifyMobileToken, startConversation);
router.get("/conversations", verifyMobileToken, getConversations);
router.get("/messages/:conversationId", verifyMobileToken, getMessages);
router.post("/messages", verifyMobileToken, sendMessage);

module.exports = router;
