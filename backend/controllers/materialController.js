const crypto = require("crypto");
const StudyMaterial = require("../models/StudyMaterial");
const { uploadBufferToS3, deleteObjectFromS3 } = require("../services/s3Service");
const { extractTextFromFile } = require("../services/fileTextService");
const { buildMaterialChunks } = require("../services/ragService");
const Quiz = require("../models/Quiz");
const cache = require("../services/cache");

function normalizeString(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

exports.uploadMaterial = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Study material file is required" });
    }

    const title = normalizeString(req.body.title) || req.file.originalname;
    const course = normalizeString(req.body.course);
    if (!course) {
      return res.status(400).json({ message: "course is required" });
    }

    const description = normalizeString(req.body.description);
    const safeFileName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const s3Key = `study-materials/${req.user.id}/${Date.now()}-${crypto.randomUUID()}-${safeFileName}`;

    const uploaded = await uploadBufferToS3({
      buffer: req.file.buffer,
      key: s3Key,
      contentType: req.file.mimetype
    });

    const extractedText = await extractTextFromFile({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname
    });

    const chunks = await buildMaterialChunks(extractedText, {
      title,
      course
    });

    const material = await StudyMaterial.create({
      title,
      description,
      course,
      uploadedBy: req.user.id,
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      s3Key: uploaded.key,
      s3Url: uploaded.url,
      extractedText,
      chunks,
      status: "approved"
    });

    cache.flushAll();

    return res.status(201).json({
      message: "Material uploaded successfully",
      material
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.listMaterials = async (req, res) => {
  try {
    const { course } = req.query;
    const filter = {};

    if (req.user.role === "student") {
      filter.status = "approved";
    } else if (req.user.role === "faculty") {
      filter.$or = [
        { uploadedBy: req.user.id },
        { status: "approved" }
      ];
    }

    if (course) {
      filter.course = course;
    }

    const materials = await StudyMaterial.find(filter)
      .sort({ createdAt: -1 })
      .populate("uploadedBy", "name email role");

    return res.json({ materials });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.getMyMaterials = async (req, res) => {
  try {
    const materials = await StudyMaterial.find({ uploadedBy: req.user.id })
      .sort({ createdAt: -1 });

    return res.json({ materials });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.deleteMaterial = async (req, res) => {
  try {
    const material = await StudyMaterial.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ message: "Material not found" });
    }

    const isOwner = String(material.uploadedBy) === String(req.user.id);
    const isAdmin = req.user.role === "admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not allowed to delete this material" });
    }

    await deleteObjectFromS3({ key: material.s3Key });

    // Remove material references from quizzes to avoid dangling IDs.
    await Quiz.updateMany(
      { materialIds: material._id },
      { $pull: { materialIds: material._id } }
    );

    // Deleting the material removes extracted text and embedded chunks stored in this document.
    await material.deleteOne();

    cache.flushAll();

    return res.json({ message: "Material deleted successfully" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
