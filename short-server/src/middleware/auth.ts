import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { config } from "../config";

export type AuthUser = { id: string; email: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Reads the token issued by the auth service, if one is present. */
function readUser(req: Request): AuthUser | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;

  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as {
      sub: string;
      email: string;
    };
    return { id: payload.sub, email: payload.email };
  } catch {
    return undefined;
  }
}

/** Attaches the user when a valid token is sent, but never blocks the request. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  req.user = readUser(req);
  next();
}

/** Blocks the request unless a valid token is sent. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = readUser(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  req.user = user;
  next();
}
