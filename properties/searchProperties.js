import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.get("/search-properties", function (req, res, next) {
    let arrayData = [];
    let filteredArr = [];
    let sql = '';

    if (req.query.type !== 'any') {
        sql = `SELECT * FROM properties WHERE (address LIKE '%${req.query.search}%' OR location = '${req.query.search}') AND type='${req.query.type}'
    AND pricing BETWEEN '${req.query.minimum}' AND '${req.query.maximum}'`;
    }
    else {
        sql = `SELECT * FROM properties WHERE (address LIKE '%${req.query.search}%' OR location = '${req.query.search}') AND pricing BETWEEN '${req.query.minimum}' AND '${req.query.maximum}'`;
    }

    let fquery = _mysqlConn.query(sql, (err, results) => {
        if (results.length > 0) {

            if (req.query.type === 'house') {
                const filter1 = results.filter((data) => data.bathrooms === req.query.bathroom && data.bedrooms === req.query.bedroom && data.toilets === req.query.toilet);

                filteredArr = filter1;
            }
            else {
                filteredArr = results;
            }

            filteredArr.forEach(element => {
                let photosArr = [];
                const photos = element.photos.split(',');

                photos.forEach(photo => {
                    photosArr.push(photo.replace("\r\n", ''));
                });

                arrayData.push({
                    id: element.property_id,
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
                    latitude: element.latitude,
                    longtitude: element.longtitude,
                    plan: element.category === 'rent' ? '/year' : null,
                    agentId: element.agentId
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
