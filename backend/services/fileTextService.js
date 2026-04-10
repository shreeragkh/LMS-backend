const pdfParseModule = require("pdf-parse");
const mammoth = require("mammoth");

async function parsePdfText(buffer) {
  // pdf-parse v1 exports a function, v2 exposes PDFParse class.
  if (typeof pdfParseModule === "function") {
    const data = await pdfParseModule(buffer);
    return data.text || "";
  }

  if (typeof pdfParseModule?.PDFParse === "function") {
    const parser = new pdfParseModule.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result?.text || "";
    } finally {
      await parser.destroy();
    }
  }

  throw new Error("Unsupported pdf-parse module export");
}

async function extractTextFromFile({ buffer, mimetype, originalname }) {
  if (mimetype === "application/pdf" || originalname?.toLowerCase().endsWith(".pdf")) {
    return parsePdfText(buffer);
  }

  if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    originalname?.toLowerCase().endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  return buffer.toString("utf8");
}

module.exports = { extractTextFromFile };
