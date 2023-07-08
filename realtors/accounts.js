import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.get("/getAgentDetails/:id", function (req, res) {

    let sql = `SELECT * FROM agents WHERE agentId = '${req.params.id}'`;

    let fquery = _mysqlConn.query(sql, (err, results) => {
        if (results.length > 0) {
            res.status(200).send({
                success: true,
                message: 'Data retrieved',
                data: results
            });
        }
        else {
            res.status(405).send({
                success: false,
                message: 'Could not retrieve data',
                data: null
            })
        }
    });

});

export default _router;
