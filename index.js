const express = require('express');
const cors = require('cors');
const { sequelize } = require("./models");
const authenticate = require("./routes/authentication.js")

const app = express();

app.use(express.json());

app.use(cors({ origin: "*" }));

app.use('/authenticate/', authenticate)


/*app.get('/users', async (req, res) => {
    try {
        const user = await User.findAll();
        return res.json(user)
    }
    catch (error) {
        console.log(error)
        res.status(500).json(error)
    }
});

// get Only 1 User by params

app.get('/users/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const user = await User.findOne({
            where: {uuid: id}
        });
        return res.json(user)
    }
    catch (error) {
        console.log(error)
        res.status(500).json(error)
    }
}); */



app.listen({ port: 7000 }, async () => {
    await sequelize.authenticate();
    console.log('Server connected')
})
