import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.patch("/login", function (req, res) {

    var username = req.body.username;

    var password = req.body.password;

    let sql = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
    _mysqlConn.query(sql, (err, results) => {
        if (results.length > 0) {
            res.status(200).send({
                success: true,
                subscribed: true,
            })
        }
        else {
            res.status(405).send({
                success: false,
                subscribed: false,
            })
        }
    })
});

export default _router;
