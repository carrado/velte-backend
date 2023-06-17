import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.patch("/create-password", function (req, res, next) {

    var passcode = req.body.passcode;
    var password = req.body.password;

    let sql = `SELECT * FROM users WHERE code = '${passcode}'`;
    let fquery = _mysqlConn.query(sql, (err, results) => {
        if (results.length > 0) {
            let sql_1 = `UPDATE users SET status = 'Active', code = '', password = '${password}' WHERE userId = '${results[0].userId}'`;
            _mysqlConn.query(sql_1, function (err, result) {
                if (err) {
                    res.status(405).send({
                        success: false,
                        subscribed: false,
                        message: "Error in re-setting password",
                    });
                }
                else {
                    res.status(200).send({
                        success: true,
                        subscribed: true,
                        message: "Password changed successfully"
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
