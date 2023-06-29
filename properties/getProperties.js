import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.get("/getAllProperties/:id", function (req, res, next) {
    let arrayData = [];
    let photosArr = [];

    let sql = `SELECT * FROM properties WHERE location = '${req.params.id}' AND category = '${req.query.category}' `;

    let fquery = _mysqlConn.query(sql, (err, results) => {
        if (results.length > 0) {

            results.forEach(element => {
                const photos = element.photos.split(',');

                photos.forEach(photo => {
                    photosArr.push(photo.replace("\r\n", ''));
                });

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
                      photos: photosArr,
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
