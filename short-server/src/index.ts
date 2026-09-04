import "dotenv/config";

import cors from "cors";
import express from "express";

import { config } from "./config";
import { initSchema } from "./db/pool";
import { linksRouter } from "./routes/links";
import { redirectRouter } from "./routes/redirect";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "short-server" })
);

app.use("/api", linksRouter);
// Kept last so it does not swallow /api or /health.
app.use("/", redirectRouter);

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
);

initSchema()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`INFO:     short-server listening on http://localhost:${config.port}`);
    });
  })
  .catch((err: NodeJS.ErrnoException) => {
    console.error(`Failed to connect to the database: ${err.message}`);

    if (err.code === "ENOTFOUND") {
      console.error(
        "The host could not be resolved. This is usually a temporary DNS " +
          "failure - try again. If it keeps happening, your network may be " +
          "IPv4-only while this Supabase host is IPv6-only; use the pooler " +
          "connection string (...pooler.supabase.com:6543) instead."
      );
    }

    process.exit(1);
  });
