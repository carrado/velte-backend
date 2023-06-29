import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.get("/getAllProperties/:id", function (req, res, next) {
    let arrayData = [];

    let sql = `SELECT * FROM properties WHERE location = '${req.params.id}' `;

    let fquery = _mysqlConn.query(sql, (err, results) => {
        if (results.length > 0) {

              results.forEach(element => {
                  arrayData.push({
                      title: element.title,
                      address: element.address,
                      utility: {
                          bedrooms: Number(element.bedrooms),
                          bathrooms: Number(element.bathrooms),
                          toilets: Number(element.toilets)
                      },
                      price: Number(element.pricing),
                      kitchen: (element.kitchen === "true"),
                      parking: (element.parking === "true"),
                      photos: [element.photos],
                      info: element.about,
                      plan: element.category === 'rent' ? '/year' : null
                })
              });
            
            res.status(200).send({
                success: true,
                message: 'Data retrieved',
                data: arrayData
            });
        }
        else {
            res.status(405).send({
                success: false,
                message: 'Could not retrieve data',
                data: null
            })
        }
    })

});



export default _router;
