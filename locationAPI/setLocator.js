import { router as _router, axios, conn } from "../header/appHeader.js";

_router.get("/", function (req, res, next) {
    const address = "7 Harmony Road Ugwuorie Iji-Nike Enugu"
    axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${address}&key=${process.env.GOOGLE_KEY}`).then((response) => {
        res.status(200).send({
            response
        })
    })
});



export default _router;
