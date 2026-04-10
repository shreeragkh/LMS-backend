const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const quizController = require("../controllers/quizController");

router.get("/", auth, quizController.listQuizzes);
router.post(
  "/generate",
  auth,
  requireRole("faculty", "admin"),
  quizController.generateQuizDraft
);
router.patch(
  "/:id/approve",
  auth,
  requireRole("faculty", "admin"),
  quizController.approveQuiz
);
router.delete(
  "/:id",
  auth,
  requireRole("faculty", "admin"),
  quizController.deleteQuiz
);
router.delete(
  "/:id/questions/:questionIndex",
  auth,
  requireRole("faculty", "admin"),
  quizController.deleteQuizQuestion
);

module.exports = router;
