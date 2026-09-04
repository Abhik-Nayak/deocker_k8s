import { useState } from "react";

import { api } from "../lib/api.js";

export default function ShortenForm({ onShortened }) {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setResult(null);
    setLoading(true);

    try {
      const link = await api.shorten(url.trim());
      setResult(link);
      setUrl("");
      onShortened?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card">
      <h2>Shorten a URL</h2>
      <form className="row" onSubmit={handleSubmit}>
        <input
          type="text"
          value={url}
          placeholder="https://example.com/a/very/long/link"
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? "Shortening…" : "Shorten"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {result && (
        <p className="result">
          <a href={result.shortUrl} target="_blank" rel="noreferrer">
            {result.shortUrl}
          </a>
          <button
            type="button"
            className="link-button"
            onClick={() => navigator.clipboard.writeText(result.shortUrl)}
          >
            copy
          </button>
        </p>
      )}
    </section>
  );
}
