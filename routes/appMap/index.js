var express = require('express');
var router = express.Router() ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) { 
    res.render('tools/appMap/index', {
        appTitle: 'UDトーク導入事例マップ（ベータ版）',
        rootURL: process.env.ROOT_URL + "/appMap",
    });		 
})) ;

module.exports = router;