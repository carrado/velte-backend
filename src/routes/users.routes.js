import express from "express";
import { patchUser } from "../controllers/users/users.controller.js";
import { verifyAuth } from "../middleware/auth.js";

const router = express.Router();

router.patch("/:id", verifyAuth, patchUser);

export default router;
