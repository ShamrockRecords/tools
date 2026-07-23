function createSubtitleChunks(tokens) {
  let result = [] ;

  for (let tokenIndex=0; tokenIndex<tokens.length; tokenIndex++) {
    let token = tokens[tokenIndex] ;
    let content = token['surface_form'] ;
    let contentTokens = [token] ;

    if (isSubtitleEndToken(content)) {
      while (tokenIndex + 1 < tokens.length && isSubtitleEndToken(tokens[tokenIndex + 1]['surface_form'])) {
        tokenIndex++ ;
        content += tokens[tokenIndex]['surface_form'] ;
        contentTokens.push(tokens[tokenIndex]) ;
      }
    }

    if (shouldAppendToPreviousChunk(content) && result.length != 0) {
      result[result.length - 1]['text'] += content ;
    } else {
      let chunk = createSubtitleChunk(content, contentTokens) ;

      if (shouldPreferPreviousLine(result[result.length - 1], content)) {
        chunk['preferPreviousLine'] = true ;
      }

      result.push(chunk) ;
    }
  }

  return result ;
}

function isSubtitleEndToken(text) {
  return text == '。' || text == '？' || text == '！' || text == '.' || text == '?' || text == '!' ;
}

function shouldAppendToPreviousChunk(text) {
  return text.trim() == '' || text == '、' || text == '，' || isSubtitleEndToken(text.charAt(0)) ;
}

function shouldPreferPreviousLine(previousChunk, text) {
  if (previousChunk == null || !/\s$/.test(previousChunk['text'])) {
    return false ;
  }

  return isEnglishWord(previousChunk['text'].trim()) && isEnglishWord(text) ;
}

function isEnglishWord(text) {
  return /^[A-Za-z0-9]+(?:['’_-][A-Za-z0-9]+)*$/.test(text) ;
}

function createSubtitleChunk(text, tokens) {
  let firstToken = tokens[0] || {} ;

  return {
    text: text,
    noLineStart: isNoLineStartToken(firstToken, text),
  } ;
}

function isNoLineStartToken(token, text) {
  let surface = token['surface_form'] || text ;

  if (/^[、。，．！？!?）」』】〕）\]\),.]+/.test(surface)) {
    return true ;
  }

  if (/^[ぁ-ん]$/.test(surface)) {
    return true ;
  }

  return token['pos'] == '助詞' || token['pos'] == '助動詞' ;
}

module.exports = createSubtitleChunks ;
