import { Router } from "express";
import session from "express-session";
var router = Router();
import { createPool } from "mysql";
import http from "http";
import cookieParser from "cookie-parser";
import axios from "axios";
import mysqlStore from "express-mysql-session";
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv'
dotenv.config();


const IN_PROD = process.env.NODE_ENV === "production";
const TWO_HOURS = 1000 * 60 * 60 * 4;

const options = {
    connectionLimit: 2000,
    password: process.env.DB_PASSWORD,
    user: process.env.DB_USERNAME,
    database: process.env.DB_DATABASE,
    host: process.env.DB_HOST
};

//create database connection
const conn = createPool(options);
const sessionStore = new mysqlStore(options, conn);


const attemptConnection = () =>
conn.getConnection((err, connection) => {
    if (err) {
        console.log(err);
        setTimeout(attemptConnection, 5000);
    } else {
        console.log('Successfully queried database.');
    }
});

attemptConnection();


router.use(
    session({
        name: process.env.SESS_NAME,
        resave: false,
        saveUninitialized: false,
        store: sessionStore,
        secret: process.env.SESS_SECRET,
        cookie: {
            maxAge: TWO_HOURS,
            sameSite: false,
            secure: IN_PROD,
        },
    })
);


export { session, conn, router, http, cookieParser, axios, mysqlStore, uuidv4 };