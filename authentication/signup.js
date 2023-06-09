import { router as _router, axios, uuidv4, conn } from "../header/appHeader.js";

_router.post("/createaccount", function (req, res, next) {
    var name = req.body.names;
    var username = req.body.username;
    var password = req.body.password;
    var mobile = req.body.phoneContact;

    // var tokenNo = (Math.floor(Math.random() * 10000) + 90000).toString();

    /* var currentTime = Math.floor(Date.now() / 1000);
     var tokenExpires = currentTime + (60 * 60).toString(); */
    
    const userId = uuidv4();

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
            let sql_2 = `INSERT INTO users (name, username, phone, password, userId) 
            VALUES ('${data.name}', '${data.username}', '${data.phone}', '${data.password}', '${data.userId}')`;

            let query = conn.query(sql_2, function (err, result) {
                if (err) {
                    res
                        .status(405)
                        .send({ success: false, message: "Error in creating User" });
                }
                else {
                    res.status(200).send({
                        success: true,
                        message: "Account created successfully",
                        data: { id: userId }
                    });
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
                                "text": "Single text message"
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
