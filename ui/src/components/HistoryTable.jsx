export default function HistoryTable({ links, onRefresh }) {
  return (
    <section className="card">
      <div className="row space-between">
        <h2>Your links</h2>
        <button type="button" className="link-button" onClick={onRefresh}>
          refresh
        </button>
      </div>

      {links.length === 0 ? (
        <p className="hint">Nothing shortened yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Short link</th>
              <th>Original URL</th>
              <th className="numeric">Clicks</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <tr key={link.id}>
                <td>
                  <a href={link.shortUrl} target="_blank" rel="noreferrer">
                    /{link.code}
                  </a>
                </td>
                <td className="truncate" title={link.targetUrl}>
                  {link.targetUrl}
                </td>
                <td className="numeric">{link.clicks}</td>
                <td>{new Date(link.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
