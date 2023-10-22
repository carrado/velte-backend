const express = require('express');
const router = express.Router();

const {
    createAccount
} = require('../controllers/authentication.js');

router.post('/createAccount', createAccount);

module.exports = router