const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const chatController = require("../controllers/chatController");

router.get("/session", auth, chatController.getCurrentSession);
router.get("/sessions", auth, chatController.listSessions);
router.get("/sessions/:sessionId/messages", auth, chatController.getMessages);
router.post("/message", auth, chatController.sendMessage);

module.exports = router;
