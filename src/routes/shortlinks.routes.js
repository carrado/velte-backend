import { Router } from "express";
import { getShortLink } from "../controllers/shortlinks/shortlinks.controller.js";

const router = Router();

router.get("/:code", getShortLink);

export default router;
