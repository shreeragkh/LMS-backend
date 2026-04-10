import { useEffect } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";

export default function Dashboard() {
  const navigate = useNavigate();
  const name = localStorage.getItem("name");

  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem("token");

      try {
        await axios.get("http://localhost:5000/api/protected", {
          withCredentials: true,
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
      } catch {
        navigate("/login");
      }
    };

    checkAuth();
  }, [navigate]);

  return (
    <div>
      <h1>Welcome {name}</h1>

      <button onClick={async () => {
        await axios.post("http://localhost:5000/api/auth/logout", {}, {
          withCredentials: true
        });
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        localStorage.removeItem("name");
        navigate("/login");
      }}>
        Logout
      </button>
    </div>
  );
}