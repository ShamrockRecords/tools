var express = require('express');
var router = express.Router() ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) {
    res.render('tools/captionEditor/index', {
        rootURL: process.env.ROOT_URL + "/jimakueditor",
        mediaType: "file",
    });		 
})) ;

module.exports = router;