var express = require('express');
var router = express.Router() ;
const line = require('@line/bot-sdk');
const access = require('../../modules/auth/paid_tool_access');

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.post('/webhook', function(req, res, next) {
    const secret = process.env.LINE_CHANNEL_SECRET;
    if (!secret || !req.lineRawBody || !line.validateSignature(req.lineRawBody, secret, req.get('x-line-signature') || '')) return res.sendStatus(403);
    next();
}, wrap(async function(req, res, next) {
    
    try {
        const config = { 
            channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
            channelSecret: process.env.LINE_CHANNEL_SECRET,
        } ;

        const bot = new line.messagingApi.MessagingApiClient(config);

        const events = req.body.events ;

        for (const event of events) {

            if (event.type === 'message' && event.message?.type === 'text' && event.message.text.length <= 50000) {
                
                let content = await makeReplyContent(event.message.text) ;
                
                await bot.replyMessage ({ replyToken: event.replyToken, messages: [{
                    type: 'text',
                    text: content,
                }] }) ;
            }
        }
    } catch (e) {

    }

    res.status(200).send("OK") ;
})) ;

router.post('/debug', access.requireAdmin, access.checkCSRF, access.limited, wrap(async function(req, res, next) {
    if (typeof req.body.prompt !== 'string' || req.body.prompt.length > 50000) return res.sendStatus(400);
    let content = await makeReplyContent(req.body.prompt) ;
          
    res.send(content) ;
})) ;

async function makeReplyContent(prompt) {
    if (prompt == undefined || prompt == "") {
        return "テキスト形式で質問は受け付けています。";
    }

    let replyMessage = await getReplyMessage(prompt) ;

    return replyMessage ;
    /*
    let keywords = await geKeywords(prompt + "\n" + replyMessage) ;
    let array = keywords.split(",") ;
    let filteredKeywords = [] ;

    for (let key in array) {
        let keyword = array[key] ;

        keyword = keyword.trim() ;

        if (keyword == "UDトーク" || 
            keyword == "トーク") {
            continue ;
        }

        filteredKeywords.push(keyword) ;
    }

    let URL = `【キーワードで動画を検索】\nhttps://capsearch.udtalk.jp/search/udtalk?pid=&q=${encodeURI(filteredKeywords.join("|"))}` ;

    return replyMessage + "\n\n" + URL ;
    */
}

async function getReplyMessage(prompt) {
    let authorization = process.env.OPEN_AI_KEY ;

    let messages = [
        {"role": "system", "content": process.env.OPEN_AI_SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ] ;

    let body = {
        "model": process.env.OPEN_AI_MODEL,
        "messages": messages,
        "temperature": 0.0,
        "max_tokens": Math.min(2048, Math.max(1, Number(process.env.OPEN_AI_MAX_TOKENS) || 2048)),
    } ;

    const param = {
        signal: AbortSignal.timeout(30000),
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

async function geKeywords(prompt) {
    let authorization = process.env.OPEN_AI_KEY ;

    let messages = [
        {"role": "system", "content": "オンラインマニュアルを検索するために使えそうな短いキーワードを与えられた文章の中から3つ作ります。結果はカンマ区切りで返します。"},
        {"role": "user", "content": prompt},
    ] ;

    let body = {
        "model": process.env.OPEN_AI_MODEL,
        "messages": messages,
        "temperature": 0.0
    } ;

    const param = {
        signal: AbortSignal.timeout(30000),
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