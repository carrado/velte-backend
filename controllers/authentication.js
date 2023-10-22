const { User } = require("../models");

const createAccount = (async (req, res) => {
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

module.exports = {
    createAccount
}