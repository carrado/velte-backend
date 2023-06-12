import { router as _router, conn } from "../header/appHeader.js";

_router.post("/setUserLocation", function (req, res, next) {
    var long = req.body.longitude;
    var lat = req.body.latitude;
    var userId = req.body.userId;

    let data = {
        longitude: long,
        latitude: lat,
        userId: userId
    };

    let sql_1 = `UPDATE users SET location = '${data.latitude},${data.longitude}' WHERE userId = '${data.userId}'`;
    _mysqlConn.query(sql_1, (err) => {
        if (err) {
            res
                .status(500)
                .send({ success: false, message: "Error in setting Location" });
        }
        else {
            res
                .status(200)
                .send({ success: false, message: "Location set successfully..." });
        }
    });
    
});





export default _router;
