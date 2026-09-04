import { useCallback, useEffect, useState } from "react";

import AuthPanel from "./components/AuthPanel.jsx";
import HistoryTable from "./components/HistoryTable.jsx";
import ShortenForm from "./components/ShortenForm.jsx";
import { api, clearToken, getToken } from "./lib/api.js";

export default function App() {
  const [user, setUser] = useState(null);
  const [links, setLinks] = useState([]);
  const [ready, setReady] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      setLinks(await api.history());
    } catch {
      setLinks([]);
    }
  }, []);

  // Restore the session from the stored token on first load.
  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }

    api
      .me()
      .then(setUser)
      .catch(() => clearToken())
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (user) loadHistory();
  }, [user, loadHistory]);

  function handleLogout() {
    clearToken();
    setUser(null);
    setLinks([]);
  }

  if (!ready) return null;

  return (
    <div className="page">
      <header>
        <h1>ShortenURL</h1>
        {user && (
          <div className="row">
            <span className="hint">{user.email}</span>
            <button type="button" className="link-button" onClick={handleLogout}>
              log out
            </button>
          </div>
        )}
      </header>

      <ShortenForm onShortened={user ? loadHistory : undefined} />

      {user ? (
        <HistoryTable links={links} onRefresh={loadHistory} />
      ) : (
        <AuthPanel onAuthenticated={setUser} />
      )}
    </div>
  );
}
