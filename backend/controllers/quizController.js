const Quiz = require("../models/Quiz");
const StudyMaterial = require("../models/StudyMaterial");
const { generateChatCompletion, hasUsableApiKey } = require("../services/aiService");
const cache = require("../services/cache");

function toQuestionsPayload(questions = []) {
  return questions.map((question) => ({
    prompt: String(question.prompt || question.question || "").trim(),
    options: Array.isArray(question.options) ? question.options.map(o => String(o || "").trim()).filter(Boolean) : [],
    answer: String(question.answer || "").trim(),
    marks: Math.max(1, Number(question.marks || 1)),
    explanation: String(question.explanation || "").trim()
  })).filter((question) => question.prompt);
}

function parseJsonArray(text = "") {
  const cleaned = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  const jsonText = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;

  const parsed = JSON.parse(jsonText);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeComparableText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/q\d+[:.)\\-\s]*/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Aggressively clean extracted source text:
 * - Remove page numbers (all common formats)
 * - Remove special symbols and unicode noise
 * - Remove document metadata lines
 * - Remove repeated whitespace
 */
function deepCleanSourceText(sourceText = "") {
  let text = String(sourceText || "");

  // Remove page number patterns
  text = text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, " ");       // -- 5 of 150 --
  text = text.replace(/\b\d+\s+of\s+\d+\b/gi, " ");              // 5 of 150
  text = text.replace(/\bpage\s+\d+\b/gi, " ");                   // Page 5
  text = text.replace(/\bp\.\s*\d+/gi, " ");                      // p. 5
  text = text.replace(/\bslide\s+\d+\b/gi, " ");                  // Slide 5
  text = text.replace(/^\s*\d+\s*$/gm, "");                       // standalone page numbers

  // Remove special symbols and unicode artifacts
  text = text.replace(/[©®™•◦▪▸►▶→←↑↓✓✗✘✔✕☐☑☒★☆◆◇■□▲△▼▽]/g, " ");
  text = text.replace(/[\u2018\u2019\u201C\u201D]/g, "'");         // smart quotes → normal
  text = text.replace(/[\u2013\u2014]/g, "-");                     // em/en dashes → hyphen
  text = text.replace(/[\u00A0]/g, " ");                           // non-breaking space
  text = text.replace(/[\u0000-\u001f]/g, " ");                    // control characters
  text = text.replace(/[^\x20-\x7E\n]/g, " ");                    // non-ASCII printable

  // Remove common PDF extraction noise
  text = text.replace(/\f/g, "\n");                                // form feeds
  text = text.replace(/\.{3,}/g, "...");                           // excessive dots

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, " ");                             // collapse horizontal spaces
  text = text.replace(/\n{3,}/g, "\n\n");                          // collapse blank lines
  text = text.trim();

  return text;
}

/**
 * Strip document metadata/header lines from source text so content is clean.
 */
function stripMetadataLines(sourceText = "") {
  const lines = sourceText.split(/\n+/);
  const contentLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length < 12) return false;

    // Skip metadata lines
    if (/^(Dr\.|Prof\.|Assistant Professor|Associate Professor|Sr\.?\s*Grade|VIT|Vellore Institute|WINTER|SUMMER|School of|Department of|Prepared by|Module\s*\d|Unit\s*\d|Chapter\s*\d|Slide\s*\d)/i.test(trimmed)) return false;
    if (/^[A-Z\d\s.,\-]{5,50}$/.test(trimmed)) return false;       // ALL-CAPS short headings
    if (/^\d+\s*of\s*\d+$/i.test(trimmed)) return false;           // page numbers
    if (/^page\s+\d+/i.test(trimmed)) return false;
    if (/copyright|all rights reserved/i.test(trimmed)) return false;
    if (/^https?:\/\//i.test(trimmed)) return false;               // URLs
    if (/^(Course Code|Reg\.?\s*No|Roll\s*No|Semester|Academic Year)/i.test(trimmed)) return false;
    if (/^(PAMCA|BCSE|BMAT|BPHY|BCHY|BENG)\d+/i.test(trimmed)) return false; // course codes

    return true;
  });

  return contentLines.join("\n") || sourceText;
}

/**
 * Full text cleaning pipeline: deep clean + strip metadata.
 */
function cleanSourceForQuiz(sourceText = "") {
  const cleaned = deepCleanSourceText(sourceText);
  return stripMetadataLines(cleaned);
}

function splitSourceSentences(sourceText = "") {
  return String(sourceText || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 25);
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Validate AI-generated questions and fix only structural issues.
 * Does NOT replace AI answers with source text.
 */
function validateAndFixAIQuestions(questions = [], excludedPromptSet = new Set()) {
  const result = [];
  const seenPrompts = new Set([...excludedPromptSet]);

  for (const question of questions) {
    const normalizedPrompt = normalizeComparableText(question.prompt);

    // Skip duplicates
    if (!normalizedPrompt || seenPrompts.has(normalizedPrompt)) continue;
    seenPrompts.add(normalizedPrompt);

    // Skip questions about metadata
    const promptLower = (question.prompt || "").toLowerCase();
    const answerLower = (question.answer || "").toLowerCase();
    const metaKeywords = ["professor", "assistant professor", "dr.", "vit", "vellore institute",
      "prepared by", "course code", "department of", "school of", "winter semester",
      "summer semester", "sr.grade", "who prepared", "who created", "pamca"];
    const isMeta = metaKeywords.some((kw) => promptLower.includes(kw) || answerLower.includes(kw));
    if (isMeta) {
      console.log(`[FILTERED] Metadata question removed: "${question.prompt}"`);
      continue;
    }

    // Ensure answer matches one of the options exactly
    let { options, answer } = question;
    if (options.length === 4) {
      const answerInOptions = options.some(opt => normalizeComparableText(opt) === normalizeComparableText(answer));
      if (!answerInOptions && answer) {
        const replaceIdx = Math.floor(Math.random() * 4);
        options[replaceIdx] = answer;
      }
    }

    // Shuffle options
    options = shuffleArray([...options]);

    result.push({ ...question, options, answer });
  }

  return result;
}

/**
 * Build fallback questions from source text when AI is unavailable.
 * Uses diverse question patterns and generates real distractors from source content.
 */
function buildFallbackQuestionsFromSource({ sourceText, count, marks, excludedPromptSet = new Set() }) {
  const cleanText = cleanSourceForQuiz(sourceText);
  const sentences = splitSourceSentences(cleanText).filter((line) => {
    if (line.length < 40 || line.length > 300) return false;
    if (/^(Dr\.|Prof\.|VIT|Vellore|WINTER|SUMMER|Prepared by|School of|Department of)/i.test(line)) return false;
    if (/copyright|all rights reserved|https?:\/\//i.test(line)) return false;
    // Skip lines that are just lists of items or numbers
    if (/^\d+[.)\s]/.test(line) && line.length < 50) return false;
    return true;
  });

  // Collect real content snippets to use as distractors
  const allSnippets = sentences
    .map(s => {
      const clean = s.replace(/\.$/, "").trim();
      return clean.length > 20 && clean.length < 150 ? clean : null;
    })
    .filter(Boolean);

  const seen = new Set([...excludedPromptSet]);
  const questions = [];

  // Different question pattern generators
  const questionGenerators = [
    // Pattern 1: Definition - "X is Y"
    (sentence) => {
      const match = sentence.match(/^(.{3,50}?)\s+is\s+((?:a|an|the)\s+.{10,180})$/i)
        || sentence.match(/^(.{3,50}?)\s+is\s+(.{15,180})$/i);
      if (!match) return null;
      const subject = match[1].trim();
      const definition = match[2].trim().replace(/\.$/, "");
      return {
        prompt: `What is ${subject}?`,
        answer: definition,
        explanation: `${subject} refers to ${definition}.`
      };
    },

    // Pattern 2: Purpose/function - "X is used for/to Y"
    (sentence) => {
      const match = sentence.match(/(.{3,50}?)\s+(?:is used for|is used to|helps to|allows|enables|provides)\s+(.{10,180})/i);
      if (!match) return null;
      const thing = match[1].trim();
      const purpose = match[2].trim().replace(/\.$/, "");
      return {
        prompt: `What is the purpose of ${thing}?`,
        answer: purpose,
        explanation: `${thing} is used to: ${purpose}.`
      };
    },

    // Pattern 3: Process/includes - "X includes/involves/requires Y"
    (sentence) => {
      const match = sentence.match(/(.{3,50}?)\s+(?:includes?|involves?|requires?|consists? of|contains?)\s+(.{10,180})/i);
      if (!match) return null;
      const topic = match[1].trim();
      const content = match[2].trim().replace(/\.$/, "");
      return {
        prompt: `What does ${topic} include?`,
        answer: content,
        explanation: `${topic} encompasses ${content}.`
      };
    },

    // Pattern 4: Comparison - "Unlike X, Y..."
    (sentence) => {
      const match = sentence.match(/(?:unlike|compared to|differs from|in contrast to)\s+(.{3,50}?),?\s+(.{10,180})/i);
      if (!match) return null;
      return {
        prompt: `How does the concept compare? ${sentence.slice(0, 80)}...`,
        answer: sentence.replace(/\.$/, ""),
        explanation: `This comparison highlights that ${sentence.charAt(0).toLowerCase() + sentence.slice(1)}`
      };
    },

    // Pattern 5: Key fact extraction - general content
    (sentence) => {
      const words = sentence.split(/\s+/);
      if (words.length < 8) return null;
      // Find nouns/concepts to ask about
      const keyPart = words.slice(0, 4).join(" ");
      return {
        prompt: `What is true about ${keyPart}?`,
        answer: sentence.replace(/\.$/, ""),
        explanation: `This is correct because ${sentence.charAt(0).toLowerCase() + sentence.slice(1)}`
      };
    },

    // Pattern 6: True/False style as MCQ
    (sentence) => {
      if (sentence.length < 30 || sentence.length > 150) return null;
      return {
        prompt: `Which of the following statements is correct?`,
        answer: sentence.replace(/\.$/, ""),
        explanation: `This statement is accurate: ${sentence}`
      };
    }
  ];

  // Pick distractors from other sentences (not the answer)
  function pickDistractors(answerText, count = 3) {
    const normalizedAnswer = normalizeComparableText(answerText);
    const candidates = allSnippets.filter(s => {
      const norm = normalizeComparableText(s);
      if (norm === normalizedAnswer) return false;
      if (norm.includes(normalizedAnswer) || normalizedAnswer.includes(norm)) return false;
      return true;
    });

    // Shuffle and pick
    const shuffled = shuffleArray([...candidates]);
    const picked = shuffled.slice(0, count);

    // If not enough real distractors, pad with generic but non-trivial ones
    const fillers = [
      "This is a common misconception about the topic",
      "This applies to a different concept entirely",
      "This describes an unrelated process",
      "This statement contradicts the source material",
      "This is only partially correct",
      "This was deprecated in modern approaches"
    ];
    const shuffledFillers = shuffleArray([...fillers]);
    let fillerIdx = 0;
    while (picked.length < count && fillerIdx < shuffledFillers.length) {
      picked.push(shuffledFillers[fillerIdx++]);
    }

    return picked.slice(0, count);
  }

  // Try each sentence with each pattern, rotating patterns for variety
  let patternIdx = 0;
  for (const sentence of shuffleArray([...sentences])) {
    if (questions.length >= count) break;

    // Try patterns starting from the current rotation
    let generated = null;
    for (let attempt = 0; attempt < questionGenerators.length; attempt++) {
      const idx = (patternIdx + attempt) % questionGenerators.length;
      generated = questionGenerators[idx](sentence);
      if (generated) {
        patternIdx = idx + 1; // rotate to next pattern
        break;
      }
    }

    if (!generated) continue;

    const normalizedPrompt = normalizeComparableText(generated.prompt);
    if (seen.has(normalizedPrompt)) continue;
    seen.add(normalizedPrompt);

    // Build 4 options: 1 correct + 3 real distractors from the material
    const distractors = pickDistractors(generated.answer, 3);
    const options = shuffleArray([generated.answer, ...distractors]);

    questions.push({
      prompt: generated.prompt,
      options,
      answer: generated.answer,
      marks,
      explanation: generated.explanation
    });
  }

  return questions;
}

exports.generateQuizDraft = async (req, res) => {
  try {
    const {
      title,
      course,
      materialIds = [],
      questions = [],
      instruction = "",
      autoGenerate = false,
      questionCount = 5,
      marksPerQuestion = 2
    } = req.body;

    if (!title || !course) {
      return res.status(400).json({ message: "title and course are required" });
    }

    if (autoGenerate && !Array.isArray(materialIds)) {
      return res.status(400).json({ message: "materialIds must be an array" });
    }

    if (autoGenerate && materialIds.length === 0) {
      return res.status(400).json({ message: "Select at least one study material for AI quiz generation" });
    }

    const materials = await StudyMaterial.find({
      _id: { $in: materialIds },
      $or: [
        { uploadedBy: req.user.id },
        { status: "approved" }
      ]
    }).lean();

    if (autoGenerate && materials.length === 0) {
      return res.status(400).json({ message: "No accessible study materials found for selected material IDs" });
    }

    const rawSourceText = materials.map((material) => material.extractedText).join("\n\n");

    const previousQuizzes = autoGenerate
      ? await Quiz.find({ materialIds: { $in: materialIds } }).select("questions.prompt").lean()
      : [];

    const excludedPromptSet = new Set(
      previousQuizzes
        .flatMap((quiz) => quiz.questions || [])
        .map((question) => normalizeComparableText(question.prompt))
        .filter(Boolean)
    );

    let generatedQuestions = toQuestionsPayload(questions);

    if (!generatedQuestions.length && autoGenerate) {
      // HARD REQUIREMENT: AI key must be configured
      if (!hasUsableApiKey()) {
        console.error("[QUIZ] No usable OpenAI API key configured. Cannot generate quiz.");
        return res.status(400).json({ message: "AI service is not configured. Please set a valid OPENAI_API_KEY to generate quizzes." });
      }

      const safeCount = Math.min(20, Math.max(1, Number(questionCount) || 5));
      const safeMarks = Math.min(20, Math.max(1, Number(marksPerQuestion) || 2));

      // Clean the source text thoroughly before any use
      const cleanSourceText = cleanSourceForQuiz(rawSourceText);

      const avoidPromptList = Array.from(excludedPromptSet).slice(0, 40).join("\n- ");
      const randomSeed = Math.floor(Math.random() * 10000);

      const prompt = `You are an expert quiz creator for a university course.

TASK: Generate exactly ${safeCount} high-quality multiple-choice questions.

Course: ${course}
Title: ${title}
${instruction ? `Additional instruction: ${instruction}` : ""}  
Marks per question: ${safeMarks}
Variation seed: ${randomSeed}

STRICT RULES:
1. Questions MUST test understanding of CONCEPTS, DEFINITIONS, PROCESSES, and FACTS from the content below
2. Each question must have exactly 4 options where exactly ONE is correct
3. The correct answer must be the option that accurately answers the question based on the material
4. The 3 wrong options (distractors) must be plausible but clearly incorrect - they should be related concepts but NOT the right answer
5. NEVER create questions about: document metadata, professor names, institutions, course codes, semester info, page numbers
6. NEVER use raw text chunks as options - options should be clean, concise statements
7. Each answer must be a clear, accurate response to its question - NOT a copy of the question text
8. NEVER start a question with "According to the study material" or "Based on the reading" or similar references to source text. Questions must be DIRECT and NATURAL.
9. Explanations must TEACH the concept - explain WHY the answer is correct in a clear, educational way. Do NOT just quote the material or say "The material states..."
10. Make questions DIVERSE - use different question types (What is, Which, How, Why, When, True/False as MCQ)
11. NEVER use "None of the above" or "All of the above" as options
12. Questions must be DIFFERENT from these previously generated ones:
${avoidPromptList ? `- ${avoidPromptList}` : "(none to avoid)"}

OUTPUT FORMAT: Return ONLY a valid JSON array. No markdown, no extra text.
Each element must be:
{
  "prompt": "Clear, direct question ending with ?",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "answer": "Exact text of the correct option (must match one of the 4 options exactly)",
  "marks": ${safeMarks},
  "explanation": "Educational explanation of WHY this answer is correct - teach the concept, dont just quote text"
}

CONTENT:
${cleanSourceText.slice(0, 12000)}

Generate ${safeCount} questions now. Return ONLY the JSON array.`;

      console.log("\n=== QUIZ GENERATION REQUEST ===");
      console.log(`Course: ${course} | Title: ${title} | Count: ${safeCount} | Seed: ${randomSeed}`);
      console.log(`Source text length (raw): ${rawSourceText.length} | (clean): ${cleanSourceText.length}`);
      console.log("Sending to AI...");

      const responseText = await generateChatCompletion({
        systemPrompt: "You are an expert academic quiz generator. You create high-quality multiple-choice questions that test conceptual understanding. You ALWAYS return valid JSON arrays. You NEVER include document metadata in questions. You NEVER reference 'study material' or 'the material' in questions. Each question has exactly 4 plausible options with exactly 1 correct answer. Answers are accurate and concise. Explanations teach the concept clearly. Never use 'None of the above' or 'All of the above' as options.",
        userPrompt: prompt,
        temperature: 0.7
      });

      console.log("\n=== AI RESPONSE ===");
      console.log(responseText ? responseText.slice(0, 500) + (responseText.length > 500 ? "..." : "") : "(empty response)");

      try {
        const parsed = parseJsonArray(responseText);
        generatedQuestions = toQuestionsPayload(parsed).map((question) => ({
          ...question,
          marks: safeMarks
        }));

        console.log(`\n=== PARSED ${generatedQuestions.length} QUESTIONS ===`);
        generatedQuestions.forEach((q, i) => {
          console.log(`Q${i + 1}: ${q.prompt}`);
          console.log(`  Answer: ${q.answer}`);
          console.log(`  Options: ${q.options.join(" | ")}`);
        });

        // Validate and fix structural issues only
        generatedQuestions = validateAndFixAIQuestions(generatedQuestions, excludedPromptSet).slice(0, safeCount);

        console.log(`\n=== FINAL ${generatedQuestions.length} QUESTIONS AFTER VALIDATION ===`);
      } catch (parseErr) {
        console.error("Failed to parse AI response:", parseErr.message);
        console.error("Raw response:", responseText?.slice(0, 500));
        generatedQuestions = [];
      }
    }

    if (!generatedQuestions.length) {
      const reason = !hasUsableApiKey()
        ? "AI service is not configured. Please set a valid OPENAI_API_KEY to generate quizzes."
        : "AI failed to generate valid questions. Please try again or check the study material content.";
      return res.status(400).json({ message: autoGenerate ? reason : "At least one valid question is required" });
    }

    const totalMarks = generatedQuestions.reduce((sum, question) => sum + question.marks, 0);

    const quiz = await Quiz.create({
      title,
      course,
      createdBy: req.user.id,
      materialIds,
      questions: generatedQuestions,
      status: "pending",
      totalMarks
    });

    cache.flushAll();

    return res.status(201).json({
      message: "Quiz draft created",
      quiz
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    return res.status(500).json({ message: error.message });
  }
};

exports.deleteQuizQuestion = async (req, res) => {
  try {
    const { id, questionIndex } = req.params;
    const index = Number(questionIndex);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ message: "questionIndex must be a non-negative integer" });
    }

    const quiz = await Quiz.findById(id);
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    const isOwner = String(quiz.createdBy) === String(req.user.id);
    const isReviewer = req.user.role === "admin" || req.user.role === "faculty";
    if (!isOwner && !isReviewer) {
      return res.status(403).json({ message: "Not allowed to modify this quiz" });
    }

    if (quiz.status !== "pending") {
      return res.status(400).json({ message: "Only pending quizzes can be edited" });
    }

    if (!quiz.questions || !quiz.questions.length) {
      return res.status(400).json({ message: "No questions available to delete" });
    }

    if (index >= quiz.questions.length) {
      return res.status(400).json({ message: "questionIndex is out of range" });
    }

    if (quiz.questions.length === 1) {
      return res.status(400).json({ message: "Quiz must have at least one question" });
    }

    quiz.questions.splice(index, 1);
    quiz.totalMarks = quiz.questions.reduce((sum, question) => sum + Number(question.marks || 0), 0);
    await quiz.save();

    cache.flushAll();

    return res.json({ message: "Question deleted", quiz });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.listQuizzes = async (req, res) => {
  try {
    const filter = {};

    if (req.user.role === "student") {
      filter.status = "approved";
    } else if (req.user.role === "faculty") {
      filter.$or = [
        { createdBy: req.user.id },
        { status: "approved" },
        { status: "pending" }
      ];
    }

    const quizzes = await Quiz.find(filter)
      .sort({ createdAt: -1 })
      .populate("createdBy", "name email role")
      .populate("materialIds", "title course s3Url status");

    return res.json({ quizzes });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.approveQuiz = async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id);
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    quiz.status = "approved";
    quiz.approvedBy = req.user.id;
    quiz.approvedAt = new Date();
    await quiz.save();

    cache.flushAll();

    return res.json({ message: "Quiz approved", quiz });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.deleteQuiz = async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id);
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    const isOwner = String(quiz.createdBy) === String(req.user.id);
    const isAdmin = req.user.role === "admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not allowed to delete this quiz" });
    }

    await quiz.deleteOne();
    cache.flushAll();

    return res.json({ message: "Quiz deleted successfully" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};