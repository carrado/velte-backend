import { router as _router, axios, conn } from "../header/appHeader.js";

_router.get("/", function (req, res, next) {
    const address = "Independence%20Layout%20Enugu"
    axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${address}&key=${process.env.GOOGLE_KEY}`).then((response) => {
        res.status(200).send({
            response
        })
    }).catch((err) => {
        res.status(400).send({
            err
        })
    })
});



export default _router;
