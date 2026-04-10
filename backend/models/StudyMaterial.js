const mongoose = require("mongoose");

const chunkSchema = new mongoose.Schema(
  {
    chunkIndex: { type: Number, required: true },
    text: { type: String, required: true },
    embedding: { type: [Number], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { _id: false }
);

const studyMaterialSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },
    course: { type: String, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    fileName: { type: String, required: true },
    fileType: { type: String, required: true },
    s3Key: { type: String, required: true },
    s3Url: { type: String, required: true },
    extractedText: { type: String, default: "" },
    chunks: { type: [chunkSchema], default: [] },
    status: {
      type: String,
      enum: ["processing", "ready", "failed", "approved"],
      default: "ready"
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date }
  },
  { timestamps: true }
);

module.exports = mongoose.model("StudyMaterial", studyMaterialSchema);
