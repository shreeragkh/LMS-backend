const ChatSession = require("../models/ChatSession");
const ChatMessage = require("../models/ChatMessage");
const Quiz = require("../models/Quiz");
const StudyMaterial = require("../models/StudyMaterial");
const { getRelevantChunks } = require("../services/ragService");
const { hasUsableApiKey, generateChatCompletion } = require("../services/aiService");
const cache = require("../services/cache");

function systemPromptForRole(role) {
  if (role === "student") {
    return "You are a study assistant for students. Only answer using study materials, quiz marks, and course content from the provided context. If the question is unrelated, refuse briefly and redirect to study-related help.";
  }

  if (role === "faculty") {
    return "You are a faculty assistant. Help with course materials, quiz generation, marks distribution, and student-related classroom planning using the provided context only.";
  }

  return "You are an admin assistant. Help with platform administration, user oversight, content approval, and learning system operations using the provided context only.";
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatSnippetContext(relevantChunks = []) {
  return relevantChunks
    .map((chunk, index) => {
      const text = normalizeText(chunk.text).slice(0, 320);
      return `Snippet ${index + 1} | title=${chunk.title} | course=${chunk.course}\n${text}`;
    })
    .join("\n\n");
}

function normalizeQuestionTokens(question = "") {
  const base = normalizeText(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

  const expanded = new Set(base);
  const normalized = normalizeText(question).toLowerCase();
  if (normalized.includes("create") || normalized.includes("created") || normalized.includes("author")) {
    expanded.add("prepared");
    expanded.add("author");
    expanded.add("created");
  }

  if (normalized.includes("mark") || normalized.includes("score")) {
    expanded.add("marks");
    expanded.add("total");
  }

  return [...expanded];
}

function splitCandidatePassages(text = "") {
  const clean = String(text || "").replace(/\r/g, " ");
  const hardSplit = clean
    .split(/\n+|(?<=[.!?;:])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (hardSplit.length > 0) {
    return hardSplit;
  }

  const compact = normalizeText(clean);
  if (!compact) return [];

  const windows = [];
  for (let start = 0; start < compact.length; start += 140) {
    windows.push(compact.slice(start, start + 220).trim());
  }
  return windows.filter(Boolean);
}

function bestPassagesForQuestion(question, chunks = []) {
  const tokens = normalizeQuestionTokens(question);
  const rawText = chunks.map((item) => item.text || "").join("\n\n");
  const passages = splitCandidatePassages(rawText).slice(0, 120);

  if (!passages.length) {
    return [];
  }

  const normalizedQuestion = normalizeText(question).toLowerCase();
  const asksCreator = /who\s+(created|prepared|made|wrote)|author|prepared by/i.test(normalizedQuestion);

  if (asksCreator) {
    const creatorPassages = passages
      .filter((p) => /prepared by|author|created by|course teacher|faculty/i.test(p))
      .slice(0, 2);
    if (creatorPassages.length) {
      return creatorPassages;
    }
  }

  const scored = [];
  for (const passage of passages) {
    const lower = passage.toLowerCase();
    const tokenMatches = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
    const density = tokenMatches / Math.max(tokens.length, 1);
    const phraseBoost = normalizedQuestion && lower.includes(normalizedQuestion) ? 0.4 : 0;
    const creatorBoost = asksCreator && /prepared by|author|created by/i.test(lower) ? 0.5 : 0;
    const score = density + phraseBoost + creatorBoost;

    if (score > 0) {
      scored.push({ passage, score });
    }
  }

  if (!scored.length) {
    return [];
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((item) => item.passage);
}

function buildFallbackAnswer({ role, question, relevantChunks }) {
  if (!relevantChunks.length) {
    if (role === "student") {
      return "I could not find this in your approved study materials or quiz data. Ask a study-related question from your course content.";
    }

    if (role === "faculty") {
      return "I could not find enough relevant course context for this question. Please upload material or ask about your courses and students.";
    }

    return "I could not find relevant admin context for this request.";
  }

  const answerPassages = bestPassagesForQuestion(question, relevantChunks);
  if (!answerPassages.length) {
    return "I could not find a precise answer in the uploaded materials. Please ask a more specific question about your document.";
  }

  return answerPassages.join(" ");
}

async function getOrCreateSession(req) {
  // Always create a fresh session so login starts with empty chat
  const session = await ChatSession.create({
    ownerUser: req.user.id,
    role: req.user.role,
    title: `${req.user.role} session`,
    lastMessageAt: new Date()
  });

  return session;
}

exports.getCurrentSession = async (req, res) => {
  try {
    const session = await getOrCreateSession(req);
    return res.json({ session });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.listSessions = async (req, res) => {
  try {
    const sessions = await ChatSession.find({ ownerUser: req.user.id, role: req.user.role }).sort({ updatedAt: -1 });
    return res.json({ sessions });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message) {
      return res.status(400).json({ message: "message is required" });
    }

    // HARD REQUIREMENT: AI key must be configured
    if (!hasUsableApiKey()) {
      console.error("[CHAT] No usable OpenAI API key configured. Cannot process chat message.");
      return res.status(503).json({ message: "AI service is not configured. Please contact the administrator to set up the API key." });
    }

    const session = sessionId
      ? await ChatSession.findOne({ _id: sessionId, ownerUser: req.user.id, role: req.user.role })
      : await getOrCreateSession(req);

    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    const cacheKey = `chat:v2:${req.user.role}:${req.user.id}:${message}:${session._id}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      await ChatMessage.create({
        sessionId: session._id,
        senderUser: req.user.id,
        senderRole: req.user.role,
        message,
        answer: cached.answer,
        sources: cached.sources
      });

      return res.json(cached);
    }

    const relevantChunks = await getRelevantChunks({
      query: message,
      role: req.user.role,
      userId: req.user.id,
      limit: 5
    });

    let context = formatSnippetContext(relevantChunks);

    if (!context) {
      if (req.user.role === "student") {
        const quizzes = await Quiz.find({ status: "approved" }).lean();
        context = `No strong material snippets found. Approved quizzes: ${quizzes.map((quiz) => `${quiz.title} (${quiz.totalMarks} marks)`).join("; ") || "none"}`;
      } else if (req.user.role === "faculty") {
        const materials = await StudyMaterial.find({ uploadedBy: req.user.id }).lean();
        context = `No strong snippets found. Your materials: ${materials.map((item) => `${item.title} (${item.course})`).join("; ") || "none"}`;
      } else {
        const [materialsCount, quizzesCount] = await Promise.all([
          StudyMaterial.countDocuments({}),
          Quiz.countDocuments({})
        ]);
        context = `No strong snippets found. System overview: materials=${materialsCount}, quizzes=${quizzesCount}`;
      }
    }

    let answer = await generateChatCompletion({
      systemPrompt: `${systemPromptForRole(req.user.role)} You are having a helpful conversation with the user. Use the provided evidence snippets to answer their question in a natural, conversational way. Synthesize the information - do NOT dump raw text or embeddings. If the evidence doesn't support an answer, say so clearly. Be concise but thorough.`,
      userPrompt: `User's question: ${message}\n\nRelevant information from course materials:\n${context}\n\nInstructions:\n1) Answer the question in a natural, conversational tone as if chatting with the user.\n2) Synthesize and explain the information clearly - don't just copy-paste raw text.\n3) If the evidence is insufficient, clearly state that you don't have enough information.\n4) Keep the answer focused and helpful, typically 2-5 sentences.`,
      temperature: 0.3
    });

    answer = normalizeText(answer);

    const result = {
      answer,
      sources: relevantChunks
    };

    await ChatMessage.create({
      sessionId: session._id,
      senderUser: req.user.id,
      senderRole: req.user.role,
      message,
      answer,
      sources: relevantChunks
    });

    session.lastMessageAt = new Date();
    await session.save();

    cache.set(cacheKey, result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const session = await ChatSession.findOne({ _id: req.params.sessionId, ownerUser: req.user.id, role: req.user.role });
    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    const messages = await ChatMessage.find({ sessionId: session._id }).sort({ createdAt: 1 });
    return res.json({ messages });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
