const express = require("express");
const multer = require("multer");
const router = express.Router();
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const materialController = require("../controllers/materialController");

const upload = multer({ storage: multer.memoryStorage() });

router.get("/", auth, materialController.listMaterials);
router.get("/mine", auth, requireRole("faculty", "admin"), materialController.getMyMaterials);
router.post(
  "/upload",
  auth,
  requireRole("faculty", "admin"),
  upload.single("file"),
  materialController.uploadMaterial
);
router.delete(
  "/:id",
  auth,
  requireRole("faculty", "admin"),
  materialController.deleteMaterial
);

module.exports = router;
