import { useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";

export default function Register() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "student"
  });

  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();

    await axios.post("http://localhost:5000/api/auth/register", form);

    alert("Registered!");
    navigate("/login");
  };

  return (
    <div>
      <h2>Register</h2>

      <form onSubmit={handleSubmit}>
        <input placeholder="Name"
          onChange={(e)=>setForm({...form, name:e.target.value})} />

        <input placeholder="Email"
          onChange={(e)=>setForm({...form, email:e.target.value})} />

        <input type="password" placeholder="Password"
          onChange={(e)=>setForm({...form, password:e.target.value})} />

        <select value={form.role} onChange={(e)=>setForm({...form, role:e.target.value})}>
          <option value="student">Student</option>
          <option value="faculty">Faculty</option>
          <option value="admin">Admin</option>
        </select>

        <button>Register</button>
      </form>
    </div>
  );
}