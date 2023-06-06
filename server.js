import http from 'http';
import app from './index.js';
import dotenv from "dotenv";
dotenv.config()

http.createServer(app).listen(8090);