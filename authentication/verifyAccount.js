import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.patch("/verifyAccount", function (req, res, next) {

    var currentTime = Math.floor(Date.now() / 1000).toString();

    var token = req.body.__tkLd5a;

    var userId = req.body.userId;

    let sql = `SELECT * FROM users WHERE code = '${token}' AND tokenElapse < '${currentTime}'`;
    let fquery = _mysqlConn.query(sql, (err, results) => {
        if (results.length > 0) {
            let sql_1 = `UPDATE users SET status = 'Active', code = '', tokenElapse = '' WHERE userId = '${userId}'`;
            _mysqlConn.query(sql_1, function (err, result) {
                if (err) {
                    res.status(405).send({
                        success: false,
                        subscribed: false,
                        message: "Error in validating Passcode",
                    });
                }
                else {
                    res.status(200).send({
                        success: true,
                        subscribed: true,
                        lynchpin: { id: userId, active: true }
                    });
                }
            });
        } else {
            res.status(405).send({
                success: false,
                subscribed: false,
                message: "Passcode entered is invalid",
            });
        }
    });
});



_router.patch("/resend-code", function (req, res, next) {

    var tokenNo = (Math.floor(Math.random() * 1000) + 9000).toString();

    var currentTime = Math.floor(Date.now() / 1000);
    var tokenExpires = currentTime + (60 * 5).toString();

    var userId = req.body.userId;

    let data = {
        userId: userId,
        token: tokenNo,
        tokenElapse: tokenExpires,
    };

    let sql_1 = `UPDATE users SET code = '${data.token}', tokenElapse = '${data.tokenElapse}' WHERE userId = '${userId}'`;
    _mysqlConn.query(sql_1, function (err, result) {
        if (err) {
            res.status(405).send({
                success: false,
                subscribed: false,
                message: "Error in sending passcode",
            });
        }
        else {
            res.status(200).send({
                success: true,
                subscribed: true,
                message: "Passcode sent successfully"
            });
        }
    });
});



_router.get("/getUserId/:id", function (req, res, next) {
    let sql = `SELECT * FROM users WHERE phone = '${req.params.id}'`;
    _mysqlConn.query(sql, (err, results) => {
        if (results.length > 0) {
            res.status(200).send({
                success: true,
                userId: results[0].userId
            });
        }
        else {
            res.status(405).send({
                success: false,
                message: `No account found with mobile number ${req.params.id}`
            })
        }
    })
});


export default _router;
