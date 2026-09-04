import { Router } from "express";

import { asyncHandler } from "../lib/async-handler";
import * as linkRepo from "../repositories/links";

export const redirectRouter = Router();

redirectRouter.get(
  "/:code",
  asyncHandler(async (req, res) => {
    const link = await linkRepo.findByCodeAndCountClick(req.params.code);
    if (!link) return res.status(404).send("Short link not found");

    res.redirect(link.target_url);
  })
);
