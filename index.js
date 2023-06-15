import express, { urlencoded, json } from "express";
var app = express();
import sharp from "sharp";
import path from "path";
import cookieParser from 'cookie-parser';
import cors from "cors";
import dotenv from "dotenv";
dotenv.config()

//To parse URL encoded data
app.use(urlencoded({ extended: false }));

//To parse json data
app.use(json());

// cookie parser middleware
app.use(cookieParser());


const corsOptions = {
    origin: '*',
    credentials: true,
    optionSuccessStatus: 200
}

app.use(cors(corsOptions));


app.use(express.static("public"));
app.use("/images", express.static("public/media/t/v16"));



/**
 * Route to authentication Endpoints
 */

import createaccount from "./authentication/signup.js";

import verifyAccount from "./authentication/verifyAccount.js";

import login from "./authentication/login.js";



app.use("/authenticate/", createaccount);
app.use("/authenticate/", verifyAccount);
app.use("/login", login);



/* import onBoard from "./onboarding/init.js";

app.use("/onboarding", onBoard);

uuidv4();
*/


// Other routes here
app.get("*", function (req, res) {
    res.status(404).send("Sorry, this is an invalid URL.");
});

export default app
