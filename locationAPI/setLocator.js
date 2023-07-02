import { router as _router, axios, conn } from "../header/appHeader.js";
import { Client } from "@googlemaps/google-maps-services-js";


const client = new Client({});



_router.get("/nearby_search", function (req, res, next) {
    client
        .placesNearby({
            params: {
                keyword: `${req.params.type}`,
                location: `${req.query.lat},${req.query.long}`,
                radius: 1500,
                key: `${process.env.GOOGLE_KEY}`
            },
            timeout: 1000, // milliseconds
        })
        .then((r) => {
            res.status(200).send({
                result: r.data.results
            });
        })
        .catch((e) => {
            res.status(500).send({
                err: "No result found"
            })
        });
});



export default _router;
