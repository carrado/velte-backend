const express = require('express');
const cors = require('cors');
const { sequelize } = require("./models");
const authenticate = require("./routes/authentication.js")
const {
    GoogleGenerativeAI,
    HarmCategory,
    HarmBlockThreshold,
} = require("@google/generative-ai");

const MODEL_NAME = "gemini-pro";
const API_KEY = "AIzaSyCQP7r3dQl7bECxGTQQu-BwEyZ_c9LKjKc";

const app = express();

app.use(express.json());

app.use(cors({ origin: "*" }));

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



app.post('/christmas', async (req, res) => {
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    const generationConfig = {
        temperature: 0.9,
        topK: 1,
        topP: 1,
        maxOutputTokens: 2048,
    };

    const safetySettings = [
        {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
    ];

    const parts = [
        { text: `${req.body.content}` },
    ];

    const result = await model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig,
        safetySettings,
    });

    const response = result.response;
    return res.status(200).json({response})
  // console.log(response.text());
})



app.listen({ port: 7000 }, async () => {
    await sequelize.authenticate();
    console.log('Server connected')
})
