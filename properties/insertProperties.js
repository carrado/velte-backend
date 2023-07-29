import { router as _router, conn, uuidv4 } from "../header/appHeader.js";

import { Client } from "@googlemaps/google-maps-services-js";


const client = new Client({});


_router.post("/insertProperties", function (req, res, next) {

    const properties_id = uuidv4();
    const agentId = uuidv4();

    if (req.headers.api_key === 'cec68e15-5f57-4e60-848a-aa928048dfee') {

        let latitude = '';
        let longtitude = '';

        const args = {
            params: {
                key: `${process.env.GOOGLE_KEY}`,
                address: `${req.body.address}`,
            }
        };

        client.geocode(args).then(gcResponse => {
            //  res.status(200).send({ data: gcResponse.data.results[0].geometry });
            latitude = gcResponse.data.results[0].geometry.location.lat;
            longtitude = gcResponse.data.results[0].geometry.location.lng;

            if (latitude !== "" && longtitude !== "") {

                let sql_2 = `INSERT INTO properties(title, address,
        bedrooms, bathrooms, toilets, pricing, facilities, photos, about, latitude, 
        longtitude, type, plots, acres, hectares, category, property_id, agentId) 
        VALUES ('${req.body.title}', '${req.body.address}', '${req.body.bedrooms}', '${req.body.bathrooms}','${req.body.toilets}', '${req.body.pricing}', '${req.body.facilities}', '${req.body.photos}', '${req.body.about}', '${latitude}', '${longtitude}','${req.body.type}', '${req.body.plots}', '${req.body.acres}', '${req.body.hectares}', '${req.body.category}', '${properties_id}','${agentId}')`;

                let fquery = conn.query(sql_2, function (err, result) {
                    if (err) {
                        res
                            .status(405)
                            .send({ success: false, message: err });
                    }
                    else {
                        res
                            .status(200)
                            .send({ success: true, message: "Property posted successfully" });
                    }
                });
            }
        });
    }
    else {
        res
            .status(405)
            .send({ success: false, message: "Invalid User, provide the API Key" });
    }
});

export default _router;

