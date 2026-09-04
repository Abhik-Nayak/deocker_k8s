import { useState } from "react";

import { api, setToken } from "../lib/api.js";

export default function AuthPanel({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const data =
        mode === "login"
          ? await api.login(email, password)
          : await api.register(email, password);

      setToken(data.access_token);
      onAuthenticated(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card">
      <h2>{mode === "login" ? "Log in" : "Create an account"}</h2>
      <p className="hint">
        Optional — shortening works without an account. Log in to keep a history
        with click counts.
      </p>

      <form className="stack" onSubmit={handleSubmit}>
        <input
          type="email"
          value={email}
          placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          value={password}
          placeholder="Password (min 6 characters)"
          onChange={(e) => setPassword(e.target.value)}
          minLength={6}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? "Please wait…" : mode === "login" ? "Log in" : "Sign up"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      <button
        type="button"
        className="link-button"
        onClick={() => {
          setMode(mode === "login" ? "register" : "login");
          setError("");
        }}
      >
        {mode === "login"
          ? "No account? Sign up"
          : "Already registered? Log in"}
      </button>
    </section>
  );
}
