import { Navigate } from "react-router-dom";

function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(String(token).split(".")[1] || ""));
    const exp = Number(payload?.exp || 0);
    if (!exp) return true;
    return Date.now() >= exp * 1000;
  } catch {
    return true;
  }
}

function clearLocalAuth() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  localStorage.removeItem("name");
  localStorage.removeItem("role");
}

export default function ProtectedRoute({ children, allowedRoles = [] }) {
  const user = localStorage.getItem("user");
  const token = localStorage.getItem("token");
  const role = localStorage.getItem("role");

  if (!user || !token) {
    clearLocalAuth();
    return <Navigate to="/login" replace />;
  }

  if (isTokenExpired(token)) {
    clearLocalAuth();
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
    if (!role) {
      clearLocalAuth();
      return <Navigate to="/login" replace />;
    }

    const fallback = role === "admin" ? "/admin" : role === "faculty" ? "/faculty" : "/student";
    return <Navigate to={fallback} replace />;
  }

  return children;
}