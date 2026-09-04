import { NextFunction, Request, Response } from "express";

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Express 4 does not forward rejected promises, so do it here. */
export const asyncHandler =
  (handler: Handler) => (req: Request, res: Response, next: NextFunction) =>
    handler(req, res).catch(next);
