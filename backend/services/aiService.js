function hasUsableApiKey() {
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) return false;
  // Ignore placeholder values copied from examples.
  if (key.startsWith("your-") || key.includes("replace-with")) return false;
  return true;
}

async function getEmbedding(text) {
  if (!hasUsableApiKey()) {
    return [];
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
        input: text
      })
    });

    if (!response.ok) {
      // Fallback to keyword retrieval when embeddings fail.
      return [];
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || [];
  } catch {
    return [];
  }
}

async function generateChatCompletion({ systemPrompt, userPrompt, temperature = 0.2 }) {
  if (!hasUsableApiKey()) {
    return "AI provider is not configured. Please add a valid OPENAI_API_KEY to enable full AI answers.";
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      return "AI service is temporarily unavailable. Please try again shortly.";
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  } catch {
    return "AI service is temporarily unavailable. Please try again shortly.";
  }
}

module.exports = { hasUsableApiKey, getEmbedding, generateChatCompletion };
