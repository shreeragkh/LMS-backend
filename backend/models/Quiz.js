const mongoose = require("mongoose");

const quizQuestionSchema = new mongoose.Schema(
  {
    prompt: { type: String, required: true },
    options: { type: [String], default: [] },
    answer: { type: String, default: "" },
    marks: { type: Number, required: true },
    explanation: { type: String, default: "" }
  },
  { _id: false }
);

const quizSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    course: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    materialIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "StudyMaterial" }],
    questions: { type: [quizQuestionSchema], default: [] },
    status: {
      type: String,
      enum: ["draft", "pending", "approved", "rejected"],
      default: "pending"
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    totalMarks: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Quiz", quizSchema);
