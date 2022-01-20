var express = require('express');
var router = express.Router() ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) {
    res.render('tools/captionEditor/index', {
        rootURL: process.env.ROOT_URL + "/jimakueditor",
        mediaType: "youtube",
    });		 
})) ;

router.post('/data', wrap(async function(req, res, next) {
    
    if (!req.headers.referer.startsWith(process.env.ROOT_URL)) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({}));
		return ;
	}
    
    var kuromoji = require("kuromoji");

    kuromoji.builder({ dicPath: "node_modules/kuromoji/dict" }).build(function (err, tokenizer) {

        if (err != null) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(req.body));
            return ;
        }

        for (let key in req.body) {
            let line = req.body[key]
            var path = tokenizer.tokenize(line["content"]);

            let contentArray = [] ;
            let content = "" ;

            for (let key in path) {
                content += path[key]["surface_form"] ;

                if ((path[key]["pos"] == '助詞' && path[key]["pos_detail_1"] != '終助詞') ||
                    path[key]["pos"] == '感動詞' ||
                    path[key]["pos"] == '接続詞' ||
                    path[key]["pos"] == '連体詞' ||
                    path[key]["surface_form"] == " " ||
                    path[key]["surface_form"] == "、" ||
                    path[key]["surface_form"] == "。") {
                    contentArray.push(content) ;
                    content = "" ;
                }
            }

            if (content != "") {
                contentArray.push(content) ;
            }

            line["content"] = contentArray ;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.body));
    });    
})) ;

module.exports = router;