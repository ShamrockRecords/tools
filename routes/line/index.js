var express = require('express');
var router = express.Router() ;
const line = require("@line/bot-sdk");

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.post('/webhook', wrap(async function(req, res, next) {
    
    try {
        const config = { 
            channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
            channelSecret: process.env.LINE_CHANNEL_SECRET,
        } ;

        const bot = new line.Client (config);

        const events = req.body.events ;

        events.forEach (async (event) => {

            if (event.type === 'message') {
                
                //let replyMessage = await getReplyMessage(event.message.text) ;
                
                bot.replyMessage (event.replyToken, {
                    type: 'text',
                    text: "こんにちは",
                }) ;
            }
        }) ;
    } catch (e) {

    }
    
    res.status(200).send("OK") ;
})) ;

async function getReplyMessage(prompt) {
    let authorization = process.env.OPEN_AI_KEY ;

    let messages = [
        {"role": "user", "content": prompt},
    ] ;

    let body = {
        "model": "gpt-3.5-turbo-16k",
        "messages": messages,
        "temperature": 0.0
    } ;

    const param = {
        method: "POST",
        headers: {"Authorization": "Bearer " + authorization, "Content-Type": "application/json"},
        body: JSON.stringify(body)
    }
    
    let data = await fetch("https://api.openai.com/v1/chat/completions", param).then(response => response.json()) ;
    let content = "" ;

    try {
        if (data.error != undefined) {
            content = data.error.message ;
        } else if (data.choices[0].message != undefined) {
            content = data.choices[0].message.content ;
        }
    } catch (e) {
        content = e.message ;
    }

    return content ;
}

module.exports = router;