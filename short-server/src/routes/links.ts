import { Router } from "express";

import { config } from "../config";
import { asyncHandler } from "../lib/async-handler";
import { generateCode, isValidUrl } from "../lib/code";
import * as linkRepo from "../repositories/links";
import { optionalAuth, requireAuth } from "../middleware/auth";

export const linksRouter = Router();

const toResponse = (link: linkRepo.LinkRow) => ({
  id: link.id,
  code: link.code,
  targetUrl: link.target_url,
  shortUrl: `${config.publicBaseUrl}/${link.code}`,
  clicks: link.clicks,
  createdAt: link.created_at,
});

/** Anyone can shorten. Logged-in users get the link saved to their history. */
linksRouter.post(
  "/shorten",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { url } = req.body ?? {};

    if (typeof url !== "string" || !isValidUrl(url)) {
      return res.status(400).json({ error: "Provide a valid http(s) URL" });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const link = await linkRepo.insert(
          generateCode(),
          url,
          req.user?.id ?? null
        );
        return res.status(201).json(toResponse(link));
      } catch (err: any) {
        if (err?.code !== linkRepo.UNIQUE_VIOLATION) throw err;
      }
    }

    return res.status(500).json({ error: "Could not generate a unique code" });
  })
);

/** History for the logged-in user, newest first. */
linksRouter.get(
  "/links",
  requireAuth,
  asyncHandler(async (req, res) => {
    const links = await linkRepo.findByUser(req.user!.id);
    res.json(links.map(toResponse));
  })
);
