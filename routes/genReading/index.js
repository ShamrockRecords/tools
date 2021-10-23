var express = require('express');
var router = express.Router() ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) {
    res.render('tools/genReading/index', {rootURL: process.env.ROOT_URL});		 
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

        let lines = req.body.lines ;
        let resultLines = [] ;

        for (let key in lines) {
            let line = lines[key]

            if (line["w"] == "") {
                continue ;
            }

            var path = tokenizer.tokenize(line["w"]);
            let s = "" ;

            for (let key in path) {
                if (path[key]["pos"] == "記号") {
                    continue ;
                }

                if (path[key]["reading"] != undefined && path[key]["reading"] != "*") {
                    s += path[key]["reading"] ;
                } else {
                    s += path[key]["surface_form"] ;
                }
            }

            s = s.replace(/・/g, '') ;
            line["as"] = kanaToHira(s) ;

            resultLines.push(line) ;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(resultLines));
    });    
})) ;

function kanaToHira(str) {
    return str.replace(/[\u30a1-\u30f6]/g, function(match) {
        var chr = match.charCodeAt(0) - 0x60;
        return String.fromCharCode(chr);
    });
}

module.exports = router;