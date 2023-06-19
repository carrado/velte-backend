import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.post("/login", function (req, res) {
    var tokenNo = (Math.floor(Math.random() * 1000) + 9000).toString();

    var currentTime = Math.floor(Date.now() / 1000);
    var tokenExpires = currentTime + (60 * 5).toString();

    var username = req.body.username;

    var password = req.body.password;

    let sql = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
    _mysqlConn.query(sql, (err, results) => {

        if (results.length === 0) {
            /**
             * No record found
             */
            res.status(405).send({
                success: false,
                subscribed: false,
                message: `Invalid username or password`
            })
        }

        else {
            /**
             * Record found but account is verified
             */
            if (results[0].status === 'active') {
                res.status(200).send({
                    success: true,
                    subscribed: true,
                    passcode: false,
                    lynchpin: { id: results[0].userId, active: true }
                })
            }

            else {
                /**
                 * Record found but account not verified yet
                 * Set another token for user to verify
                 * Send an SMS to enable account verification
                 */
                let sql_1 = `UPDATE users SET code = '${tokenNo}', tokenElapse = '${tokenExpires}' WHERE userId = '${results[0].userId}'`;
                _mysqlConn.query(sql_1, function (err, result) {
                    /* let tokenSchema = {
                        "receiver": {
                            "contacts": [
                                {
                                    "identifierValue": `${result[0].phone}`
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
                            Authorization: `AccessKey ${process.env.ACCESSKEY}`
                        }
                    }).then(() => {}) */

                    res.status(200).send({
                        success: true,
                        subscribed: true,
                        passcode: true,
                        message: "Passcode resent",
                        lynchpin: {id: results[0].userId, active: false}
                    })
                })
            }
        }
    })
});

export default _router;
