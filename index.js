const express = require('express');
const cors = require('cors');
const { sequelize, User } = require("./models");

const app = express();

app.use(express.json());

app.use(cors({ origin: "*" }));


app.post('/users', async (req, res) => {
    const { name, email, accountType, username, password } = req.body;

    try {
        const user = await User.create({ name, email, accountType, username, password, subscription: false });
        return res.status(200).json({ message: 'Account Created Successfully', user })
    }
    catch (error) {
        console.log(error)
        res.status(500).json(error)
    }
})


app.listen({ port: 7000 }, async () => {
    await sequelize.authenticate();
    console.log('Server connected')
})
