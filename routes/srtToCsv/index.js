var express = require('express');
var router = express.Router() ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) {
    res.render('tools/srtToCsv/index', {rootURL: process.env.ROOT_URL + "/srt2csv"});		 
})) ;

module.exports = router;