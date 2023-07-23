import { router as _router, conn as _mysqlConn } from "../header/appHeader.js";

_router.get("/search-properties", function (req, res, next) {
    let arrayData = [];
    let filteredArr = [];
    let sql = '';
    
    sql = `SELECT * FROM properties WHERE address LIKE '%${req.query.search}%' OR location = '${req.query.search}'`;

    let fquery = _mysqlConn.query(sql, (err, results) => {
        if (results.length > 0) {
            
            filteredArr = results;

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
                    facilities: element.facilities,
                    photos: photosArr,
                    info: element.about,
                    latitude: element.latitude,
                    longtitude: element.longtitude,
                    type: element.type,
                    size: {
                        plot: element.plots,
                        acres: element.acres,
                        hectares: element.hectares
                    },
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
