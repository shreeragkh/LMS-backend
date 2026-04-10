import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../lib/api";

const emptyQuestion = () => ({ prompt: "", marks: 5, answer: "", options: "", explanation: "" });

export default function RoleWorkspace({ role }) {
  const navigate = useNavigate();
  const currentUser = (() => {
    try {
      return JSON.parse(localStorage.getItem("user") || "{}");
    } catch {
      return {};
    }
  })();
  const currentUserId = String(currentUser?.id || "");
  const isAdmin = role === "admin";
  const [userName, setUserName] = useState(localStorage.getItem("name") || "User");
  const [materials, setMaterials] = useState([]);
  const [quizzes, setQuizzes] = useState([]);
  const [sessionId, setSessionId] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatTyping, setChatTyping] = useState(false);
  const [reviewQuizId, setReviewQuizId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [uploadForm, setUploadForm] = useState({ title: "", course: "", description: "", file: null });
  const [quizForm, setQuizForm] = useState({
    title: "",
    course: "",
    instruction: "",
    questionCount: 5,
    marksPerQuestion: 2,
    materialIds: [],
    questions: [emptyQuestion()]
  });

  const chatEndRef = useRef(null);

  const scrollChatToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollChatToBottom();
  }, [chatMessages, chatTyping]);

  const roleTitle = useMemo(() => {
    if (role === "faculty") return "Faculty";
    if (role === "admin") return "Admin";
    return "Student";
  }, [role]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError("");
      const [materialsRes, quizzesRes, sessionRes] = await Promise.all([
        api.get("/materials"),
        api.get("/quizzes"),
        api.get("/chat/session")
      ]);

      setMaterials(materialsRes.data.materials || []);
      setQuizzes(quizzesRes.data.quizzes || []);
      setSessionId(sessionRes.data.session?._id || "");
    } catch (err) {
      if (err.response?.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        localStorage.removeItem("name");
        localStorage.removeItem("role");
        navigate("/login", { replace: true });
        return;
      }
      setError(err.response?.data?.message || err.message || "Failed to load workspace");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [role]);

  const handleLogout = async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // ignore
    }
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    localStorage.removeItem("name");
    localStorage.removeItem("role");
    navigate("/login");
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!uploadForm.file) {
      setError("Please choose a file before uploading");
      return;
    }

    const formData = new FormData();
    formData.append("title", uploadForm.title);
    formData.append("course", uploadForm.course);
    formData.append("description", uploadForm.description);
    formData.append("file", uploadForm.file);

    try {
      setError("");
      await api.post("/materials/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" }
      });

      setUploadForm({ title: "", course: "", description: "", file: null });
      await loadData();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to upload material");
    }
  };

  const updateQuestion = (index, field, value) => {
    setQuizForm((prev) => {
      const questions = [...prev.questions];
      questions[index] = { ...questions[index], [field]: value };
      return { ...prev, questions };
    });
  };

  const addQuestion = () => {
    setQuizForm((prev) => ({ ...prev, questions: [...prev.questions, emptyQuestion()] }));
  };

  const removeQuestion = (index) => {
    setQuizForm((prev) => ({
      ...prev,
      questions: prev.questions.filter((_, itemIndex) => itemIndex !== index)
    }));
  };

  const handleGenerateQuiz = async (e, mode = "manual") => {
    e.preventDefault();

    const isAiMode = mode === "ai";

    let title = quizForm.title.trim();
    let course = quizForm.course.trim();

    if (isAiMode && (!title || !course) && quizForm.materialIds.length) {
      const firstMaterial = materials.find((material) => quizForm.materialIds.includes(material._id));
      if (firstMaterial) {
        title = title || `${firstMaterial.title} Quiz`;
        course = course || firstMaterial.course;
      }
    }

    if (!title || !course) {
      setError("Quiz title and course are required");
      return;
    }

    if (isAiMode && quizForm.materialIds.length === 0) {
      setError("Select at least one study material for AI quiz generation");
      return;
    }

    try {
      setError("");
      const payload = {
        title,
        course,
        materialIds: quizForm.materialIds,
        instruction: quizForm.instruction,
        autoGenerate: isAiMode,
        questionCount: Number(quizForm.questionCount) || 5,
        marksPerQuestion: Number(quizForm.marksPerQuestion) || 2,
        questions: isAiMode ? [] : quizForm.questions.map((question) => ({
          prompt: question.prompt,
          marks: Number(question.marks),
          answer: question.answer,
          options: question.options
            .split("|")
            .map((item) => item.trim())
            .filter(Boolean),
          explanation: question.explanation
        }))
      };

      console.log("=== QUIZ GENERATION REQUEST (frontend) ===");
      console.log("Mode:", isAiMode ? "AI" : "Manual");
      console.log("Payload:", JSON.stringify({ ...payload, questions: payload.questions.length }, null, 2));

      const response = await api.post("/quizzes/generate", payload);

      console.log("=== QUIZ GENERATION RESPONSE (frontend) ===");
      const quiz = response.data?.quiz;
      if (quiz) {
        console.log(`Quiz: "${quiz.title}" | ${quiz.questions?.length || 0} questions`);
        (quiz.questions || []).forEach((q, i) => {
          console.log(`Q${i + 1}: ${q.prompt}`);
          console.log(`  Options: ${(q.options || []).join(" | ")}`);
          console.log(`  Answer: ${q.answer}`);
          console.log(`  Explanation: ${q.explanation}`);
        });
      }

      setQuizForm({
        title: "",
        course: "",
        instruction: "",
        questionCount: 5,
        marksPerQuestion: 2,
        materialIds: [],
        questions: [emptyQuestion()]
      });
      await loadData();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to create quiz");
    }
  };

  const handleApproveQuiz = async (quizId) => {
    try {
      setError("");
      await api.patch(`/quizzes/${quizId}/approve`);
      await loadData();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to approve quiz");
    }
  };

  const toggleQuizReview = (quizId) => {
    setReviewQuizId((prev) => (prev === quizId ? "" : quizId));
  };

  const handleDeleteReviewedQuestion = async (quizId, questionIndex) => {
    try {
      setError("");
      await api.delete(`/quizzes/${quizId}/questions/${questionIndex}`);
      await loadData();
      setReviewQuizId(quizId);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to delete question");
    }
  };

  const handleDeleteMaterial = async (materialId) => {
    try {
      setError("");
      await api.delete(`/materials/${materialId}`);
      await loadData();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to delete material");
    }
  };

  const handleDeleteQuiz = async (quizId) => {
    try {
      setError("");
      await api.delete(`/quizzes/${quizId}`);
      if (reviewQuizId === quizId) {
        setReviewQuizId("");
      }
      await loadData();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to delete quiz");
    }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const userMsg = chatInput.trim();
    setChatMessages((prev) => [...prev, { role: "user", text: userMsg }]);
    setChatInput("");
    setChatTyping(true);

    try {
      setError("");
      const res = await api.post("/chat/message", {
        sessionId,
        message: userMsg
      });

      setChatMessages((prev) => [...prev, { role: "ai", text: res.data.answer || "No response received." }]);
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message || "Failed to get a response.";
      setChatMessages((prev) => [...prev, { role: "error", text: errMsg }]);
    } finally {
      setChatTyping(false);
    }
  };

  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <div>
          <p className="workspace-kicker">{roleTitle} portal</p>
          <h1>Welcome {userName} {role} role</h1>
        </div>
        <button className="secondary-button" onClick={handleLogout}>Logout</button>
      </header>

      {error && <div className="alert error">{error}</div>}
      {loading && <div className="alert">Loading workspace...</div>}

      <section className="grid-layout">
        <div className="card">
          <h2>Study materials</h2>
          <ul className="list">
            {materials.map((material) => (
              <li key={material._id} className="list-item">
                <strong>{material.title}</strong>
                <span>{material.course}</span>
                <a href={material.s3Url} target="_blank" rel="noreferrer">Open file</a>
                {(isAdmin || String(material?.uploadedBy?._id || material?.uploadedBy || "") === currentUserId) && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => handleDeleteMaterial(material._id)}
                  >
                    Delete material
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2>Approved quizzes</h2>
          <ul className="list">
            {quizzes.filter((quiz) => quiz.status === "approved").map((quiz) => (
              <li key={quiz._id} className="list-item">
                <strong>{quiz.title}</strong>
                <span>{quiz.course} · {quiz.totalMarks} marks</span>
                {(isAdmin || String(quiz?.createdBy?._id || quiz?.createdBy || "") === currentUserId) && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => handleDeleteQuiz(quiz._id)}
                  >
                    Delete quiz
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {(role === "faculty" || role === "admin") && (
        <section className="grid-layout">
          <div className="card">
            <h2>Upload study material to S3</h2>
            <form className="stack-form" onSubmit={handleUpload}>
              <input
                placeholder="Title"
                value={uploadForm.title}
                onChange={(e) => setUploadForm({ ...uploadForm, title: e.target.value })}
              />
              <input
                placeholder="Course"
                value={uploadForm.course}
                onChange={(e) => setUploadForm({ ...uploadForm, course: e.target.value })}
              />
              <textarea
                placeholder="Description"
                value={uploadForm.description}
                onChange={(e) => setUploadForm({ ...uploadForm, description: e.target.value })}
              />
              <input
                type="file"
                onChange={(e) => setUploadForm({ ...uploadForm, file: e.target.files?.[0] || null })}
              />
              <button type="submit">Upload</button>
            </form>
          </div>

          <div className="card">
            <h2>Create quiz draft</h2>
            <form className="stack-form" onSubmit={(e) => handleGenerateQuiz(e, "manual")}>
              <input
                placeholder="Quiz title"
                value={quizForm.title}
                onChange={(e) => setQuizForm({ ...quizForm, title: e.target.value })}
              />
              <input
                placeholder="Course"
                value={quizForm.course}
                onChange={(e) => setQuizForm({ ...quizForm, course: e.target.value })}
              />
              <textarea
                placeholder="Instruction"
                value={quizForm.instruction}
                onChange={(e) => setQuizForm({ ...quizForm, instruction: e.target.value })}
              />

              <div className="row-buttons">
                <input
                  placeholder="AI question count"
                  type="number"
                  min="1"
                  max="20"
                  value={quizForm.questionCount}
                  onChange={(e) => setQuizForm({ ...quizForm, questionCount: e.target.value })}
                />
                <input
                  placeholder="Marks per question"
                  type="number"
                  min="1"
                  max="20"
                  value={quizForm.marksPerQuestion}
                  onChange={(e) => setQuizForm({ ...quizForm, marksPerQuestion: e.target.value })}
                />
              </div>

              <div className="material-picker">
                {materials.map((material) => (
                  <label key={material._id}>
                    <input
                      type="checkbox"
                      checked={quizForm.materialIds.includes(material._id)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setQuizForm((prev) => ({
                          ...prev,
                          materialIds: checked
                            ? [...prev.materialIds, material._id]
                            : prev.materialIds.filter((id) => id !== material._id)
                        }));
                      }}
                    />
                    {material.title}
                  </label>
                ))}
              </div>

              <div className="question-list">
                {quizForm.questions.map((question, index) => (
                  <div key={index} className="question-card">
                    <input
                      placeholder="Question"
                      value={question.prompt}
                      onChange={(e) => updateQuestion(index, "prompt", e.target.value)}
                    />
                    <input
                      placeholder="Marks"
                      type="number"
                      value={question.marks}
                      onChange={(e) => updateQuestion(index, "marks", e.target.value)}
                    />
                    <input
                      placeholder="Options separated by |"
                      value={question.options}
                      onChange={(e) => updateQuestion(index, "options", e.target.value)}
                    />
                    <input
                      placeholder="Answer"
                      value={question.answer}
                      onChange={(e) => updateQuestion(index, "answer", e.target.value)}
                    />
                    <textarea
                      placeholder="Explanation"
                      value={question.explanation}
                      onChange={(e) => updateQuestion(index, "explanation", e.target.value)}
                    />
                    {quizForm.questions.length > 1 && (
                      <button type="button" className="secondary-button" onClick={() => removeQuestion(index)}>
                        Remove question
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="row-buttons">
                <button type="button" className="secondary-button" onClick={addQuestion}>Add question</button>
                <button type="submit">Generate quiz (manual)</button>
                <button type="button" onClick={(e) => handleGenerateQuiz(e, "ai")}>Generate quiz with AI</button>
              </div>
            </form>
          </div>
        </section>
      )}

      {(role === "admin" || role === "faculty") && (
        <section className="card">
          <h2>Pending quizzes</h2>
          <ul className="list">
            {quizzes.filter((quiz) => quiz.status === "pending").map((quiz) => (
              <li key={quiz._id} className="list-item">
                <div className="pending-quiz-block">
                  <div>
                    <strong>{quiz.title}</strong>
                    <span>{quiz.course} · {quiz.totalMarks} marks · {quiz.questions?.length || 0} questions</span>
                  </div>

                  <div className="row-buttons">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => toggleQuizReview(quiz._id)}
                    >
                      {reviewQuizId === quiz._id ? "Hide review" : "Review questions"}
                    </button>
                    <button type="button" onClick={() => handleApproveQuiz(quiz._id)}>Approve</button>
                    {(isAdmin || String(quiz?.createdBy?._id || quiz?.createdBy || "") === currentUserId) && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => handleDeleteQuiz(quiz._id)}
                      >
                        Delete quiz
                      </button>
                    )}
                  </div>

                  {reviewQuizId === quiz._id && (
                    <div className="quiz-review-list">
                      {(quiz.questions || []).map((question, index) => (
                        <div key={`${quiz._id}-${index}`} className="question-card">
                          <p><strong>Q{index + 1}:</strong> {question.prompt}</p>
                          <p><strong>Marks:</strong> {question.marks}</p>
                          {Array.isArray(question.options) && question.options.length > 0 && (
                            <p><strong>Options:</strong> {question.options.join(" | ")}</p>
                          )}
                          <p><strong>Answer:</strong> {question.answer || "N/A"}</p>
                          {question.explanation && <p><strong>Explanation:</strong> {question.explanation}</p>}
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => handleDeleteReviewedQuestion(quiz._id, index)}
                          >
                            Delete question
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card chat-card">
        <h2>Chat with AI Assistant</h2>
        <div className="chat-messages">
          {chatMessages.length === 0 && !chatTyping && (
            <div className="chat-empty">Ask a question to start chatting...</div>
          )}
          {chatMessages.map((msg, i) => (
            <div
              key={i}
              className={`chat-bubble ${msg.role === "user" ? "chat-bubble-user" : msg.role === "error" ? "chat-bubble-error" : "chat-bubble-ai"}`}
            >
              <span className="chat-bubble-label">{msg.role === "user" ? "You" : msg.role === "error" ? "Error" : "AI Assistant"}</span>
              <p>{msg.text}</p>
            </div>
          ))}
          {chatTyping && (
            <div className="chat-bubble chat-bubble-ai">
              <span className="chat-bubble-label">AI Assistant</span>
              <div className="chat-typing-indicator">
                <span></span><span></span><span></span>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        <form className="chat-input-bar" onSubmit={sendMessage}>
          <input
            type="text"
            placeholder={`Ask the ${role} assistant...`}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
          />
          <button type="submit" disabled={chatTyping || !chatInput.trim()}>Send</button>
        </form>
      </section>
    </div>
  );
}