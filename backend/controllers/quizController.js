const Quiz = require("../models/Quiz");
const StudyMaterial = require("../models/StudyMaterial");
const { generateChatCompletion, hasUsableApiKey } = require("../services/aiService");
const cache = require("../services/cache");

function toQuestionsPayload(questions = []) {
  return questions.map((question) => ({
    prompt: String(question.prompt || question.question || "").trim(),
    options: Array.isArray(question.options) ? question.options : [],
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
    .replace(/q\d+[:.)\-\s]*/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSourceSentences(sourceText = "") {
  return String(sourceText || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 20);
}

function pickSourceLineForPrompt(prompt = "", sourceSentences = []) {
  const normalizedPrompt = normalizeComparableText(prompt);
  const promptTokens = normalizedPrompt.split(" ").filter((token) => token.length >= 4);

  if (!promptTokens.length) {
    return sourceSentences[0] || "";
  }

  let bestLine = "";
  let bestScore = -1;

  for (const line of sourceSentences) {
    const normalizedLine = normalizeComparableText(line);
    let score = 0;
    for (const token of promptTokens) {
      if (normalizedLine.includes(token)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestLine = line;
    }
  }

  return bestLine || sourceSentences[0] || "";
}

function buildOptionPool(sourceSentences = []) {
  const pool = [];

  for (const sentence of sourceSentences) {
    const fragments = sentence
      .split(/[,:;()-]/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 12 && part.length <= 120);

    for (const fragment of fragments) {
      const normalized = String(fragment || "").replace(/\s+/g, " ").trim();
      if (normalized.length >= 12 && normalized.length <= 110) {
        pool.push(normalized);
      }
    }
  }

  return [...new Set(pool)];
}

function optionLooksTooSimilar(option = "", answer = "") {
  const o = normalizeComparableText(option);
  const a = normalizeComparableText(answer);
  if (!o || !a) return false;
  if (o === a) return true;
  if (o.includes(a) || a.includes(o)) return true;

  const aTokens = new Set(a.split(" ").filter((token) => token.length >= 4));
  const oTokens = o.split(" ").filter((token) => token.length >= 4);
  if (!aTokens.size || !oTokens.length) return false;

  const overlap = oTokens.filter((token) => aTokens.has(token)).length;
  return overlap / Math.max(aTokens.size, 1) >= 0.7;
}

function ensureFourOptionsWithSingleCorrect(question, sourceSentences = []) {
  const answer = String(question.answer || "").trim();
  const normalizedAnswer = normalizeComparableText(answer);
  const existingOptions = Array.isArray(question.options) ? question.options : [];
  const cleanOptions = existingOptions
    .map((option) => String(option || "").trim())
    .filter(Boolean);

  const uniqueOptions = [];
  const optionSet = new Set();
  for (const option of cleanOptions) {
    const normalized = normalizeComparableText(option);
    if (!normalized || optionSet.has(normalized)) continue;
    optionSet.add(normalized);
    uniqueOptions.push(option);
  }

  if (answer && !optionSet.has(normalizedAnswer)) {
    uniqueOptions.unshift(answer);
    optionSet.add(normalizedAnswer);
  }

  const pool = buildOptionPool(sourceSentences);
  for (const candidate of pool) {
    if (uniqueOptions.length >= 4) break;
    const normalizedCandidate = normalizeComparableText(candidate);
    if (!normalizedCandidate || optionSet.has(normalizedCandidate)) continue;
    if (optionLooksTooSimilar(candidate, answer)) continue;
    uniqueOptions.push(candidate);
    optionSet.add(normalizedCandidate);
  }

  // Last resort fillers to always keep exactly 4 options.
  const fallbackFillers = [
    "None of the above",
    "All of the above",
    "Only the first statement",
    "Only the second statement"
  ];
  for (const fallback of fallbackFillers) {
    if (uniqueOptions.length >= 4) break;
    const normalized = normalizeComparableText(fallback);
    if (optionSet.has(normalized)) continue;
    uniqueOptions.push(fallback);
    optionSet.add(normalized);
  }

  const finalOptions = uniqueOptions.slice(0, 4);

  // Ensure exactly one option equals the answer text.
  let matchCount = finalOptions.filter((option) => normalizeComparableText(option) === normalizedAnswer).length;
  if (matchCount === 0 && finalOptions.length) {
    finalOptions[0] = answer || finalOptions[0];
    matchCount = finalOptions.filter((option) => normalizeComparableText(option) === normalizedAnswer).length;
  }

  if (matchCount > 1) {
    let seenCorrect = false;
    for (let index = 0; index < finalOptions.length; index += 1) {
      if (normalizeComparableText(finalOptions[index]) === normalizedAnswer) {
        if (!seenCorrect) {
          seenCorrect = true;
        } else {
          finalOptions[index] = `Distractor option ${index + 1}`;
        }
      }
    }
  }

  return finalOptions.map((option) => String(option || "").replace(/\s+/g, " ").trim());
}

function dedupeQuestions(questions = [], excludedPromptSet = new Set()) {
  const seen = new Set([...excludedPromptSet]);
  const result = [];

  for (const question of questions) {
    const normalizedPrompt = normalizeComparableText(question.prompt);
    if (!normalizedPrompt || seen.has(normalizedPrompt)) {
      continue;
    }

    seen.add(normalizedPrompt);
    result.push(question);
  }

  return result;
}

function buildQuestionFromSentence(sentence, index) {
  const cleanSentence = String(sentence || "").replace(/^\d+\.?\s*/, "").trim();
  const sentenceWithoutPeriod = cleanSentence.replace(/[.\s]+$/, "");

  const totalMarksMatch = sentenceWithoutPeriod.match(/total\s+marks?\s*[:=-]?\s*(\d+\s*marks?)/i);
  if (totalMarksMatch) {
    return {
      prompt: "What total marks are mentioned in the study material?",
      answer: totalMarksMatch[1],
      explanation: `The uploaded material explicitly states the total marks as ${totalMarksMatch[1]}.`
    };
  }

  const isPattern = sentenceWithoutPeriod.match(/^(.{3,80}?)\s+is\s+(.{3,180})$/i);
  if (isPattern) {
    const subject = isPattern[1].trim();
    const predicate = isPattern[2].trim();
    return {
      prompt: `What is ${subject}?`,
      answer: predicate,
      explanation: `The study material describes ${subject} as ${predicate}.`
    };
  }

  const colonPattern = sentenceWithoutPeriod.match(/^(.{3,100}?)\s*:\s*(.{3,180})$/);
  if (colonPattern) {
    const key = colonPattern[1].trim();
    const value = colonPattern[2].trim();
    return {
      prompt: `What does the material list for ${key}?`,
      answer: value,
      explanation: `In the uploaded document, ${key} is given as ${value}.`
    };
  }

  const topic = sentenceWithoutPeriod.split(/\s+/).slice(0, 7).join(" ");
  const answer = sentenceWithoutPeriod.split(/\s+/).slice(0, 18).join(" ");
  return {
    prompt: `According to the material, what is stated about ${topic}?`,
    answer,
    explanation: `This answer is derived directly from the uploaded study material context: ${sentenceWithoutPeriod}.`
  };
}

function improveGeneratedQuestions(questions = [], sourceText = "", excludedPromptSet = new Set()) {
  const sourceSentences = splitSourceSentences(sourceText).filter((line) => line.length >= 30);

  const improved = questions.map((question, index) => {
    const prompt = String(question.prompt || "").trim().replace(/^Q\d+[:.)\-\s]*/i, "");
    let answer = String(question.answer || "").trim();
    let explanation = String(question.explanation || "").trim();

    const sameAnswer = normalizeComparableText(prompt) && normalizeComparableText(prompt) === normalizeComparableText(answer);
    const weakExplanation = !explanation || /generated from|auto[- ]?generated|ai generated/i.test(explanation);

    if (sameAnswer || !answer) {
      const bestSource = sourceSentences.find((line) => {
        const firstWord = normalizeComparableText(prompt).split(" ")[0];
        if (!firstWord) return false;
        return normalizeComparableText(line).includes(firstWord);
      }) || sourceSentences[index] || sourceSentences[0] || prompt;

      const rebuilt = buildQuestionFromSentence(bestSource, index);

      // Keep original prompt when it is clear and question-like.
      const looksLikeQuestion = /\?$/.test(prompt) || /^what|why|how|which|when|who/i.test(prompt);
      const finalPrompt = looksLikeQuestion ? prompt : rebuilt.prompt;

      return {
        ...question,
        prompt: finalPrompt,
        answer: rebuilt.answer,
        explanation: weakExplanation ? rebuilt.explanation : explanation
      };
    }

    if (weakExplanation) {
      const supportLine = pickSourceLineForPrompt(prompt, sourceSentences);
      explanation = supportLine
        ? `From the document: ${supportLine}`
        : `The answer is grounded in the uploaded study material for the question: ${prompt}.`;
    }

    return {
      ...question,
      prompt,
      answer,
      explanation,
      options: ensureFourOptionsWithSingleCorrect({ ...question, prompt, answer }, sourceSentences)
    };
  });

  return dedupeQuestions(improved, excludedPromptSet);
}

function buildFallbackQuestionsFromSource({ sourceText, count, marks, excludedPromptSet = new Set() }) {
  const sentences = splitSourceSentences(sourceText).filter((line) => line.length >= 45);

  const picked = [];
  for (const sentence of sentences) {
    if (picked.length >= count) break;
    // Skip boilerplate/noisy lines that are usually not good quiz material.
    if (/https?:\/\//i.test(sentence) || /copyright|all rights reserved/i.test(sentence)) {
      continue;
    }
    picked.push(sentence);
  }

  const fallbackQuestions = picked.map((sentence, index) => {
    const built = buildQuestionFromSentence(sentence, index);
    const supportLine = pickSourceLineForPrompt(built.prompt, splitSourceSentences(sourceText));
    return {
      prompt: built.prompt,
      options: [],
      answer: built.answer,
      marks,
      explanation: supportLine
        ? `From the document: ${supportLine}`
        : built.explanation
    };
  });

  return improveGeneratedQuestions(fallbackQuestions, sourceText, excludedPromptSet);
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
        { status: "approved" },
        { uploadedBy: req.user.id }
      ]
    }).lean();

    if (autoGenerate && materials.length === 0) {
      return res.status(400).json({ message: "No accessible study materials found for selected material IDs" });
    }

    const sourceText = materials.map((material) => material.extractedText).join("\n\n");

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
      const safeCount = Math.min(20, Math.max(1, Number(questionCount) || 5));
      const safeMarks = Math.min(20, Math.max(1, Number(marksPerQuestion) || 2));
      if (hasUsableApiKey()) {
        const avoidPromptList = Array.from(excludedPromptSet).slice(0, 40).join("\n- ");

        // Strip noisy header/metadata lines before sending to AI.
        // These are short lines (< 60 chars) that look like document metadata:
        // professor names, institution names, course codes, semester info, etc.
        const contentLines = sourceText
          .split(/\n+/)
          .filter((line) => {
            const trimmed = line.trim();
            if (trimmed.length < 20) return false; // skip very short lines
            // Skip lines that look like slide headers / metadata (no sentence structure)
            if (/^(Dr\.|Prof\.|Assistant Professor|Associate Professor|Sr\.Grade|VIT|Vellore Institute|WINTER|SUMMER|School of|Department of|Prepared by|Module|Unit \d|Chapter \d|Slide \d)/i.test(trimmed)) return false;
            if (/^[A-Z\d\s]{5,40}$/.test(trimmed)) return false; // ALL-CAPS short lines (headings)
            return true;
          })
          .join("\n");

        const cleanSourceText = contentLines || sourceText;

        const prompt = `You are creating a quiz for a university course. Generate exactly ${safeCount} multiple-choice questions based ONLY on the substantive educational content below.

Course: ${course}
Title: ${title}
${instruction ? `Additional instruction: ${instruction}` : ""}
Marks per question: ${safeMarks}

CRITICAL RULES:
1. Questions must be about the actual SUBJECT MATTER (concepts, definitions, processes, facts) - NOT about document metadata (professor names, institutions, course codes, semester)
2. Return ONLY a valid JSON array, no other text
3. Each item must have: prompt (a clear question), options (array of exactly 4 strings), answer (exact text matching one option), marks (${safeMarks}), explanation (1-2 sentences citing a fact from the material)
4. Exactly ONE option must match the answer exactly
5. The other 3 options must be plausible but clearly wrong distractors
6. Do NOT create questions about: who prepared the document, what institution, what professor, what semester, course codes
7. Do NOT repeat these previous questions: ${avoidPromptList || "(none)"}

STUDY MATERIAL CONTENT:
${cleanSourceText.slice(0, 12000)}

Return ONLY the JSON array, starting with [ and ending with ].`;

        console.log("\n=== QUIZ GENERATION REQUEST ===");
        console.log(`Course: ${course} | Title: ${title} | Count: ${safeCount}`);
        console.log(`Source text length: ${cleanSourceText.length} chars`);
        console.log("Sending to AI...");

        const responseText = await generateChatCompletion({
          systemPrompt: "You are an expert quiz creator. You generate high-quality multiple-choice questions from educational content. Return ONLY valid JSON arrays. Never create questions about document metadata like professor names or institution names.",
          userPrompt: prompt,
          temperature: 0.3
        });

        console.log("\n=== AI RESPONSE ===");
        console.log(responseText ? responseText.slice(0, 500) + (responseText.length > 500 ? "..." : "") : "(empty response)");

        try {
          const parsed = parseJsonArray(responseText);
          generatedQuestions = toQuestionsPayload(parsed).map((question) => ({
            ...question,
            marks: safeMarks
          }));

          // Filter out any metadata questions that slipped through
          generatedQuestions = generatedQuestions.filter((q) => {
            const promptLower = (q.prompt || "").toLowerCase();
            const answerLower = (q.answer || "").toLowerCase();
            const metadataKeywords = ["professor", "assistant professor", "dr.", "vit", "vellore institute", "prepared by", "course code", "department of", "school of", "winter", "summer semester", "sr.grade"];
            const isMeta = metadataKeywords.some((kw) => promptLower.includes(kw) || answerLower.includes(kw));
            if (isMeta) {
              console.log(`[FILTERED] Metadata question removed: "${q.prompt}"`);
            }
            return !isMeta;
          });

          console.log(`\n=== GENERATED ${generatedQuestions.length} QUESTIONS ===`);
          generatedQuestions.forEach((q, i) => {
            console.log(`Q${i + 1}: ${q.prompt}`);
            console.log(`  Answer: ${q.answer}`);
          });

          generatedQuestions = improveGeneratedQuestions(generatedQuestions, sourceText, excludedPromptSet).slice(0, safeCount);
        } catch (parseErr) {
          console.error("Failed to parse AI response:", parseErr.message);
          generatedQuestions = [];
        }
      }

      if (!generatedQuestions.length) {
        console.log("\n=== USING FALLBACK QUESTION BUILDER (no AI or AI returned empty) ===");
        generatedQuestions = buildFallbackQuestionsFromSource({
          sourceText,
          count: safeCount,
          marks: safeMarks,
          excludedPromptSet
        });
      }

      generatedQuestions = improveGeneratedQuestions(generatedQuestions, sourceText, excludedPromptSet).slice(0, safeCount);
    }

    if (!generatedQuestions.length) {
      return res.status(400).json({ message: autoGenerate ? "Could not generate quiz from selected study materials" : "At least one valid question is required" });
    }

    generatedQuestions = generatedQuestions.map((question) => ({
      ...question,
      options: ensureFourOptionsWithSingleCorrect(question, splitSourceSentences(sourceText))
    }));

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