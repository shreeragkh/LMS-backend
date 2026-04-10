const mongoose = require("mongoose");

const chatSessionSchema = new mongoose.Schema(
  {
    ownerUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["student", "faculty", "admin"], required: true },
    title: { type: String, default: "Main session" },
    summary: { type: String, default: "" },
    lastMessageAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

chatSessionSchema.index({ ownerUser: 1, role: 1 }, { unique: true });

module.exports = mongoose.model("ChatSession", chatSessionSchema);
