var express = require('express');
var router = express.Router() ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) { 
    res.render('tools/appMap/index', {
        appTitle: 'アプリ導入プログラム提供マップ',
        rootURL: process.env.ROOT_URL + "/appMap",
    });		 
})) ;

module.exports = router;