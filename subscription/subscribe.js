import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.post("/subscribe", function (req, res) {

    var txRef = req.body.transactionRef;
    var userId = req.body.userId;
    var duration = req.body.duration;
    var amount = req.body.amount;


    var currentTime = Math.floor(Date.now() / 1000);
    var subscriptionExpires = currentTime + (86400 * 30).toString();


    let sql_2 = `INSERT INTO subscription (userId, transactionRef, duration, amount, subscriptionElapse) 
            VALUES ('${userId}', '${txRef}', '${duration}', '${amount}', '${subscriptionExpires}')`;

    let query = _mysqlConn.query(sql_2, function (err, result) {
        if (err) {
            res
                .status(405)
                .send({ success: false, message: "Subscription Failed..." });
        }
        else {
            res.status(200).send({
                success: true,
                message: "Subscription successful",
                lynchpin: { id: userId, active: true, subscriptionStatus: true }
            });
        }
    });
});

export default _router;
