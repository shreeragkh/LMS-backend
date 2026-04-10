const cache = require("./cache");
const { getEmbedding } = require("./aiService");
const StudyMaterial = require("../models/StudyMaterial");

const STOP_WORDS = new Set([
  "the", "is", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "at", "by",
  "from", "as", "that", "this", "it", "be", "are", "was", "were", "who", "what", "when",
  "where", "which", "how", "why", "do", "does", "did", "can", "could", "would", "should"
]);

const CHUNK_MIN_TOKENS = 200;
const CHUNK_MAX_TOKENS = 500;
const PASSAGE_MIN_TOKENS = 40;
const PASSAGE_MAX_TOKENS = 180;
const TYPE_EMBEDDING_THRESHOLD = 0.2;

const TYPE_PROTOTYPES = {
  faculty: "faculty teacher professor course instructor department institution prepared by",
  marks: "marks score grading total marks rubric evaluation",
  quiz: "quiz question multiple choice answer explanation assessment",
  general: "course material study content learning notes"
};

function tokenize(text = "") {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function normalizeForRetrieval(text = "") {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[©®•]/g, " ")
    .trim();
}

function estimateTokenCount(text = "") {
  const words = normalizeForRetrieval(text)
    .split(/\s+/)
    .filter(Boolean);
  return words.length;
}

function splitIntoSentences(text = "") {
  return normalizeForRetrieval(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length >= 15);
}

function compactChunkText(sentences = []) {
  return sentences
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractStructuredMetadata(text = "", baseMetadata = {}) {
  const source = normalizeForRetrieval(text);
  const metadata = {
    type: baseMetadata.type || "",
    course: baseMetadata.course || "",
    courseCode: "",
    name: "",
    role: "",
    department: "",
    institution: ""
  };

  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const lineText = lines.join(" ");

  const courseCodeMatch = source.match(/\b([A-Z]{3,}[A-Z0-9]*\d{2,})\b/);
  if (courseCodeMatch) metadata.courseCode = courseCodeMatch[1];

  const namedCourseMatch = source.match(/course\s+name\s*[:\-]?\s*([^.;]{3,80})/i);
  if (namedCourseMatch && !metadata.course) {
    metadata.course = namedCourseMatch[1].trim();
  }

  const nameMatch = lineText.match(/\b(Dr\.?\s+[A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,4})\b/);
  if (nameMatch) {
    metadata.name = nameMatch[1].replace(/\s+/g, " ").trim();
  }

  const roleMatch = lineText.match(/\b(Assistant Professor(?:\s*\(?.{0,20}?\)?)?|Associate Professor|Professor|Lecturer|Faculty)\b/i);
  if (roleMatch) {
    metadata.role = roleMatch[1].replace(/\s+/g, " ").trim();
  }

  const deptMatch = lineText.match(/\b(Computer Science(?:\s+Engineering)?|Information Systems|Data Science|Electronics(?:\s+and\s+Communication)?|Mechanical Engineering|Civil Engineering)\b/i);
  if (deptMatch) {
    metadata.department = deptMatch[1].replace(/\s+/g, " ").trim();
  }

  const institutionMatch = lineText.match(/\b(VIT(?:\s+Vellore)?|Vellore Institute of Technology|[A-Z][A-Za-z\s]+University|[A-Z][A-Za-z\s]+Institute(?:\s+of\s+Technology)?)\b/i);
  if (institutionMatch) {
    metadata.institution = institutionMatch[1].replace(/\s+/g, " ").trim();
  }

  const facultySignal = Boolean(metadata.name || metadata.role || metadata.department || metadata.institution);
  const marksSignal = /\bmarks?\b/i.test(source);
  const quizSignal = /\bquiz|question|assessment\b/i.test(source);

  if (facultySignal) metadata.type = "faculty";
  else if (marksSignal) metadata.type = "marks";
  else if (quizSignal) metadata.type = "quiz";
  else metadata.type = metadata.type || "general";

  return metadata;
}

async function inferTypeFromEmbedding(text = "") {
  const chunkEmbedding = await getEmbedding(text);
  if (!chunkEmbedding.length) {
    return { type: "general", score: 0, embedding: [] };
  }

  let bestType = "general";
  let bestScore = -1;

  for (const [type, prototypeText] of Object.entries(TYPE_PROTOTYPES)) {
    const key = `embed:type:${type}`;
    let prototypeEmbedding = cache.get(key);
    if (!prototypeEmbedding) {
      prototypeEmbedding = await getEmbedding(prototypeText);
      if (prototypeEmbedding.length) {
        cache.set(key, prototypeEmbedding);
      }
    }

    if (!prototypeEmbedding || !prototypeEmbedding.length) continue;
    const score = cosineSimilarity(chunkEmbedding, prototypeEmbedding);
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  if (bestScore < TYPE_EMBEDDING_THRESHOLD) {
    return { type: "general", score: bestScore, embedding: chunkEmbedding };
  }

  return { type: bestType, score: bestScore, embedding: chunkEmbedding };
}

function formatStructuredPrefix(metadata = {}) {
  const lines = [];
  if (metadata.name) lines.push(`Name: ${metadata.name}`);
  if (metadata.role) lines.push(`Role: ${metadata.role}`);
  if (metadata.department) lines.push(`Department: ${metadata.department}`);
  if (metadata.institution) lines.push(`Institution: ${metadata.institution}`);
  if (metadata.courseCode) lines.push(`CourseCode: ${metadata.courseCode}`);
  if (metadata.course) lines.push(`Course: ${metadata.course}`);
  if (metadata.type && metadata.type !== "general") lines.push(`Type: ${metadata.type}`);
  return lines.join("\n");
}

function toSelfContainedChunkText(chunkTextValue, metadata = {}) {
  const body = normalizeForRetrieval(chunkTextValue);
  const prefix = formatStructuredPrefix(metadata);
  if (!prefix) return body;
  return normalizeForRetrieval(`${prefix}\n\n${body}`);
}

function expandQueryTokens(query = "") {
  const base = tokenize(query);
  const expanded = new Set(base);

  const queryText = String(query).toLowerCase();
  if (queryText.includes("create") || queryText.includes("created") || queryText.includes("author")) {
    expanded.add("prepared");
    expanded.add("author");
    expanded.add("by");
  }

  if (queryText.includes("mark") || queryText.includes("score")) {
    expanded.add("marks");
    expanded.add("total");
  }

  if (queryText.includes("quiz")) {
    expanded.add("question");
    expanded.add("assessment");
  }

  if (queryText.includes("document") || queryText.includes("material") || queryText.includes("study")) {
    expanded.add("cycle");
    expanded.add("sheet");
    expanded.add("lab");
    expanded.add("content");
  }

  if (queryText.includes("faculty") || queryText.includes("professor") || queryText.includes("teacher")) {
    expanded.add("faculty");
    expanded.add("department");
    expanded.add("institution");
  }

  return [...expanded];
}

function inferQueryType(query = "") {
  const q = String(query || "").toLowerCase();
  if (/who\s+(created|prepared|teaches|teacher)|author|prepared\s+by|professor|faculty|department|institution/.test(q)) {
    return "faculty";
  }
  if (/marks?|score|total\s+marks/.test(q)) {
    return "marks";
  }
  if (/quiz|question|assessment/.test(q)) {
    return "quiz";
  }
  return "general";
}

function chunkText(text, minTokens = CHUNK_MIN_TOKENS, maxTokens = CHUNK_MAX_TOKENS) {
  const cleanText = normalizeForRetrieval(text);
  if (!cleanText) return [];

  const sentences = splitIntoSentences(cleanText);
  if (!sentences.length) return [];

  const chunks = [];
  let current = [];
  let currentTokens = 0;

  const flushCurrent = (carry = []) => {
    if (!current.length) return;
    const textChunk = compactChunkText(current);
    if (textChunk) {
      chunks.push(textChunk);
    }

    current = carry.slice();
    currentTokens = estimateTokenCount(compactChunkText(current));
  };

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokenCount(sentence);

    if (current.length && currentTokens + sentenceTokens > maxTokens) {
      const carry = current.slice(Math.max(0, current.length - 1));
      flushCurrent(carry);
    }

    current.push(sentence);
    currentTokens += sentenceTokens;

    if (currentTokens >= minTokens && currentTokens <= maxTokens && sentence.endsWith(".")) {
      // Prefer sentence-aware chunk boundaries while keeping chunks self-contained.
      const carry = current.slice(Math.max(0, current.length - 1));
      flushCurrent(carry);
    }
  }

  flushCurrent([]);

  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    if (estimateTokenCount(last) < Math.floor(minTokens / 2)) {
      chunks[chunks.length - 2] = compactChunkText([chunks[chunks.length - 2], last]);
      chunks.pop();
    }
  }

  return chunks;
}

function cosineSimilarity(vectorA = [], vectorB = []) {
  if (!vectorA.length || !vectorB.length || vectorA.length !== vectorB.length) {
    return 0;
  }

  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < vectorA.length; i += 1) {
    dot += vectorA[i] * vectorB[i];
    magnitudeA += vectorA[i] * vectorA[i];
    magnitudeB += vectorB[i] * vectorB[i];
  }

  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB) || 1);
}

function keywordScore(text = "", query = "") {
  const haystack = normalizeForRetrieval(text).toLowerCase();
  const words = expandQueryTokens(query);
  if (!words.length) return 0;

  const uniqueWords = [...new Set(words)];
  const matched = uniqueWords.filter((word) => haystack.includes(word)).length;
  const coverage = matched / uniqueWords.length;

  let phraseBoost = 0;
  const normalizedQuery = String(query).toLowerCase().replace(/\s+/g, " ").trim();
  if (normalizedQuery && haystack.includes(normalizedQuery)) {
    phraseBoost = 0.25;
  }

  return Math.min(1, coverage + phraseBoost);
}

function lexicalOverlapScore(text = "", query = "") {
  const textTokens = new Set(tokenize(text));
  const queryTokens = expandQueryTokens(query);
  if (!queryTokens.length) return 0;

  const overlap = queryTokens.filter((token) => textTokens.has(token)).length;
  return overlap / queryTokens.length;
}

function splitPassages(text = "") {
  const sentences = splitIntoSentences(text)
    .filter((line) => !/^page\s+\d+/i.test(line))
    .filter((line) => !/https?:\/\//i.test(line));

  if (!sentences.length) return [];

  const passages = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const window = [];
    let tokenCount = 0;

    for (let j = i; j < sentences.length; j += 1) {
      const sentence = sentences[j];
      window.push(sentence);
      tokenCount += estimateTokenCount(sentence);

      if (tokenCount >= PASSAGE_MIN_TOKENS) {
        break;
      }

      if (tokenCount >= PASSAGE_MAX_TOKENS) {
        break;
      }
    }

    const passage = compactChunkText(window);
    if (passage.length >= 35) {
      passages.push(passage);
    }
  }

  return [...new Set(passages)];
}

async function getPassageEmbeddingCached(text) {
  const normalized = normalizeForRetrieval(text);
  if (!normalized) return [];

  const key = `embed:passage:${normalized.slice(0, 180)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const embedding = await getEmbedding(normalized);
  if (embedding.length) {
    cache.set(key, embedding);
  }

  return embedding;
}

async function buildMaterialChunks(materialText, materialContext = {}) {
  const rawChunks = chunkText(materialText);
  const prepared = [];

  for (let index = 0; index < rawChunks.length; index += 1) {
    const rawText = normalizeForRetrieval(rawChunks[index]);
    const metadata = extractStructuredMetadata(rawText, { type: "general" });

    // Only carry material-level course into a chunk when the chunk is actually course-related.
    if (!metadata.course && materialContext.course && keywordScore(rawText, materialContext.course) >= 0.2) {
      metadata.course = materialContext.course;
    }

    const text = toSelfContainedChunkText(rawText, metadata);
    const inferred = await inferTypeFromEmbedding(text);
    const embedding = inferred.embedding;
    if (metadata.type === "general" && inferred.type !== "general") {
      metadata.type = inferred.type;
    }
    metadata.typeScore = Number(inferred.score || 0);

    prepared.push({
      chunkIndex: index,
      text,
      embedding,
      metadata
    });
  }

  return prepared;
}

function rerankCandidates(candidates = [], query = "", limit = 5) {
  const normalizedQuery = normalizeForRetrieval(query);
  const queryTokens = expandQueryTokens(query);
  const queryType = inferQueryType(query);

  const scored = candidates.map((candidate) => {
    const lexical = keywordScore(candidate.text, normalizedQuery);
    const overlap = lexicalOverlapScore(candidate.text, normalizedQuery);
    const titleBoost = keywordScore(`${candidate.title || ""} ${candidate.course || ""}`, normalizedQuery);
    const semantic = Number(candidate.semanticScore || candidate.baseScore || candidate.score || 0);
    const chunkScore = Number(candidate.chunkScore || candidate.baseScore || candidate.score || 0);
    const metadataType = candidate.metadata?.type || "general";
    const metadataTypeBoost = queryType !== "general" && metadataType === queryType ? 0.12 : 0;
    const metadataText = [
      candidate.metadata?.name,
      candidate.metadata?.role,
      candidate.metadata?.department,
      candidate.metadata?.institution,
      candidate.metadata?.course,
      candidate.metadata?.courseCode
    ].filter(Boolean).join(" ");
    const metadataBoost = metadataText ? keywordScore(metadataText, normalizedQuery) * 0.08 : 0;

    const score = (semantic * 0.45)
      + (lexical * 0.25)
      + (overlap * 0.15)
      + (titleBoost * 0.1)
      + (chunkScore * 0.05)
      + metadataTypeBoost
      + metadataBoost;

    return {
      ...candidate,
      score,
      queryMatches: queryTokens.filter((token) => normalizeForRetrieval(candidate.text).toLowerCase().includes(token)).length
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.queryMatches !== a.queryMatches) return b.queryMatches - a.queryMatches;
    return estimateTokenCount(b.text) - estimateTokenCount(a.text);
  });

  const selected = [];
  const seenKeys = new Set();

  for (const item of scored) {
    const key = `${item.materialId}:${item.chunkIndex}:${normalizeForRetrieval(item.text).slice(0, 120)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    selected.push(item);
    if (selected.length >= limit) break;
  }

  return selected;
}

async function getRelevantChunks({ query, role, userId, limit = 5 }) {
  const cacheKey = `rag:${role}:${userId}:${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const materialFilter = role === "student"
    ? { status: "approved" }
    : role === "faculty"
      ? { $or: [{ uploadedBy: userId }, { status: "approved" }] }
      : {};

  const materials = await StudyMaterial.find(materialFilter).sort({ createdAt: -1 }).lean();

  const normalizedQuery = normalizeForRetrieval(query);
  const queryEmbedding = await getEmbedding(normalizedQuery);
  const queryType = inferQueryType(query);

  const chunkCandidates = [];

  for (const material of materials) {
    for (const chunk of material.chunks || []) {
      const metadataType = chunk.metadata?.type || "general";
      if (queryType !== "general" && metadataType !== queryType && metadataType !== "general") {
        continue;
      }

      const semanticScore = queryEmbedding.length && chunk.embedding?.length
        ? cosineSimilarity(queryEmbedding, chunk.embedding)
        : 0;
      const lexicalScore = keywordScore(chunk.text, normalizedQuery);
      const titleScore = keywordScore(`${material.title} ${material.course}`, normalizedQuery);
      const blendedChunkScore = queryEmbedding.length
        ? (semanticScore * 0.55) + (lexicalScore * 0.25) + (titleScore * 0.2)
        : (lexicalScore * 0.8) + (titleScore * 0.2);

      if (blendedChunkScore < 0.1) continue;

      chunkCandidates.push({
        material,
        chunk,
        chunkScore: blendedChunkScore,
        semanticScore,
        lexicalScore,
        titleScore,
        metadataType
      });
    }
  }

  const topChunks = rerankCandidates(
    chunkCandidates.map((item) => ({
      materialId: String(item.material._id),
      title: item.material.title,
      course: item.material.course,
      uploadedBy: String(item.material.uploadedBy),
      chunkIndex: item.chunk.chunkIndex,
      text: item.chunk.text,
      chunkScore: item.chunkScore,
      semanticScore: item.semanticScore,
      lexicalScore: item.lexicalScore,
      titleScore: item.titleScore,
      metadata: item.chunk.metadata || {},
      status: item.material.status
    })),
    query,
    12
  );

  const passageScores = [];
  for (const item of topChunks) {
    const passages = splitPassages(item.text);
    const candidates = passages.length ? passages : [normalizeForRetrieval(item.text)];

    for (const passage of candidates.slice(0, 8)) {
      const lexical = keywordScore(passage, normalizedQuery);
      const overlap = lexicalOverlapScore(passage, normalizedQuery);
      let semantic = 0;

      if (queryEmbedding.length) {
        const passageEmbedding = await getPassageEmbeddingCached(passage);
        if (passageEmbedding.length) {
          semantic = cosineSimilarity(queryEmbedding, passageEmbedding);
        }
      }

      const score = queryEmbedding.length
        ? (semantic * 0.5) + (lexical * 0.25) + (overlap * 0.15) + (item.score * 0.1)
        : (lexical * 0.55) + (overlap * 0.2) + (item.score * 0.25);

      if (score < 0.14) continue;

      passageScores.push({
        materialId: item.materialId,
        title: item.title,
        course: item.course,
        uploadedBy: item.uploadedBy,
        chunkIndex: item.chunkIndex,
        text: passage,
        metadata: item.metadata || {},
        score,
        status: item.status
      });
    }
  }

  const top = rerankCandidates(passageScores, query, limit).map((item) => ({
    materialId: item.materialId,
    title: item.title,
    course: item.course,
    uploadedBy: item.uploadedBy,
    chunkIndex: item.chunkIndex,
    text: item.text,
    metadata: item.metadata || {},
    score: item.score,
    status: item.status
  }));

  cache.set(cacheKey, top);
  return top;
}

const { openai } = require("./aiService"); // adjust if needed

// 🔥 FINAL ANSWER GENERATION (MOST IMPORTANT FIX)
async function generateAnswer(query, chunks = []) {
  if (!chunks.length) return "No relevant information found.";

  const context = chunks
    .map((c, i) => {
    let clean = c.text
      .replace(/PAMCA\d+/g, "")   // remove course codes
      .replace(/\bWINTER\s*\d+/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    return `(${i + 1}) ${clean}`;
  })
    .join("\n\n");

  const prompt = `
You are a precise academic assistant.

Extract the exact answer from the context.

Rules:
- DO NOT copy full sentences blindly
- DO NOT include course codes, headings, or metadata
- ONLY return the meaningful answer
- If asking "who is", return role + institution
- If definition, return clean definition only

Question:
${query}

Context:
${context}

Answer:
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0].message.content.trim();
}

// 🔥 MAIN FUNCTION (USE THIS IN CONTROLLER INSTEAD OF getRelevantChunks)
async function askQuestion({ query, role, userId }) {
  const chunks = await getRelevantChunks({ query, role, userId, limit:8 });
  chunks = chunks.filter(c => {
  const text = c.text.toLowerCase();

  // remove useless headers / noise
  if (text.includes("winter") || text.includes("page") || text.includes("©")) return false;

  // remove overly long noisy chunks
  if (text.length > 500) return false;

  return true;
}).slice(0, 5);

  const answer = await generateAnswer(query, chunks);

  return answer;
}
module.exports = {
  chunkText,
  buildMaterialChunks,
  askQuestion,
  getRelevantChunks
};
