import { router as _router, axios, uuidv4, conn } from "../header/appHeader.js";
import dotenv from 'dotenv'
dotenv.config();



import { Vonage } from "@vonage/server-sdk";

const vonage = new Vonage({
    apiKey: process.env.NEXMOAPI,
    apiSecret: process.env.NEXMOSECRETKEY
})






async function sendSMS(mobile, token, userId, res) {
    const from = "Velte"
    const to = "2348163276826"
    const text = `Dear customer, use this One Time Password ${token} to verify your account. This OTP will be valid for the next 5 mins.`

    await vonage.sms.send({ to, from, text })
        .then(resp => {
            res.status(200).send({
                success: true,
                message: "Account created successfully",
                lynchpin: { id: userId, active: false }
            });
        })
        .catch(err => { console.log('There was an error sending the messages.'); console.error(err); });
}





_router.post("/createaccount", function (req, res, next) {
    var name = req.body.names;
    var username = req.body.username;
    var password = req.body.password;
    var mobile = req.body.phoneContact;
    
    const userId = uuidv4();

    var tokenNo = (Math.floor(Math.random() * 1000) + 9000).toString();

    var currentTime = Math.floor(Date.now() / 1000);
    var tokenExpires = currentTime + (60 * 5).toString();

    let data = {
        userId: userId,
        name: name,
        username: username,
        phone: mobile,
        password: password,
    };

    let sql = `SELECT * FROM users WHERE phone = '${data.phone}'`;
    let fquery = conn.query(sql, (err, result) => {
        if (result.length > 0) {
            res.status(405).send({
                success: false,
                message: `Account already exists`,
            });
        }
        else {
            let sql_2 = `INSERT INTO users (name, username, phone, password, userId, code, tokenElapse) 
            VALUES ('${data.name}', '${data.username}', '${data.phone}', '${data.password}', '${data.userId}', '${tokenNo}', '${tokenExpires}')`;

            let query = conn.query(sql_2, function (err, result) {
                if (err) {
                    res
                        .status(405)
                        .send({ success: false, message: "Error in creating User" });
                }
                else {

                    sendSMS(data.phone, tokenNo, data.userId, res)

                   /* let tokenSchema = {
                        "receiver": {
                            "contacts": [
                                {
                                    "identifierValue": "+2348163276826"
                                }
                            ]
                        },
                        "body": {
                            "type": "text",
                            "text": {
                                "text": `Dear customer, use this One Time Password ${tokenNo} to verify your account. This OTP will be valid for the next 5 mins.`
                            }
                        }
                    }

                    axios.post(`https://nest.messagebird.com/workspaces/${process.env.WORKSPACE_ID}/channels/${process.env.SMS_CHANNEL}/messages`, tokenSchema, {
                        headers: {
                            Authorization: `AccessKey ${process.env.ACCESSKEY
                        }`
                        }
                    }).then(() => {
                        res.status(200).send({
                            success: true,
                            message: "Account created successfully",
                            data: {id: userId}
                        });
                    }) */
                }
            });
        }
    });
});





export default _router;
