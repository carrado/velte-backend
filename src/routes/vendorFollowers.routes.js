import express from "express";
import { verifyAuth } from "../middleware/auth.js";
import { getMyFollowers } from "../controllers/buyerSaved/vendorFollowers.controller.js";

const router = express.Router();

router.get("/", verifyAuth, getMyFollowers);

export default router;
