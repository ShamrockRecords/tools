var express = require('express');
var router = express.Router() ;
var fetch = require('node-fetch') ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) {
    res.render('tools/youyaku/index', {rootURL: process.env.ROOT_URL + "/youyaku"});		 
})) ;

router.post('/data', wrap(async function(req, res, next) {
    
    if (!req.headers.referer.startsWith(process.env.ROOT_URL)) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({}));
		return ;
	}
    
    let command = req.body.command ;
    let lines = req.body.lines ;

    let text = "" ;

    for (let key in lines) {
        text += lines[key]
    }
    
    res.setHeader('Content-Type', 'text/plain');
    res.end(await getSummary(text, command));
})) ;

async function getSummary(text, command) {
    let authorization = process.env.OPEN_AI_KEY ;

    let body = {
        "model": "gpt-3.5-turbo",
        "messages": [
      {"role": "user", "content": command},
      {"role": "user", "content": text}
      ],
        "temperature": 0.2
    } ;
    const param = {
        method: "POST",
        headers: {"Authorization": "Bearer " + authorization, "Content-Type": "application/json"},
        body: JSON.stringify(body)
    }

    let data = "" ;

    try {
        data = await fetch("https://api.openai.com/v1/chat/completions", param).then(response => response.json()) ;
        return data.choices[0].message.content ;
    } catch (e) {
        console.log(e) ;
        return "" ;
    }    
}

module.exports = router;