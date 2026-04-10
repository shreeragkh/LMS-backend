import { useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";

export default function Login() {
  const [form, setForm] = useState({
    email: "",
    password: ""
  });

  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await axios.post(
        "http://localhost:5000/api/auth/login",
        form,
        { withCredentials: true }
      );

      localStorage.setItem("token", res.data.token);
      localStorage.setItem("user", JSON.stringify(res.data.user));
      localStorage.setItem("name", res.data.user?.name || "User");
      localStorage.setItem("role", res.data.user?.role || "student");

      const rolePath = {
        student: "/student",
        faculty: "/faculty",
        admin: "/admin"
      }[res.data.user?.role || "student"];

      navigate(rolePath);
    } catch (err) {
      console.error("Login error:", err.response?.data || err.message);
      alert("Login failed: " + (err.response?.data?.msg || err.message));
    }
  };

  return (
    <div>
      <h2>Login</h2>

      <form onSubmit={handleSubmit}>
        <input placeholder="Email"
          onChange={(e)=>setForm({...form, email:e.target.value})} />

        <input type="password" placeholder="Password"
          onChange={(e)=>setForm({...form, password:e.target.value})} />

        <button>Login</button>
      </form>
    </div>
  );
}