function createSubtitleChunks(tokens) {
  let result = [] ;

  for (let tokenIndex=0; tokenIndex<tokens.length; tokenIndex++) {
    let token = tokens[tokenIndex] ;
    let content = token['surface_form'] ;
    let contentTokens = [token] ;

    if (shouldJoinWithNextToken(token, tokens[tokenIndex + 1])) {
      tokenIndex++ ;
      content += tokens[tokenIndex]['surface_form'] ;
      contentTokens.push(tokens[tokenIndex]) ;
    }

    content = repairSmallKanaBoundary(content, result) ;

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

function shouldJoinWithNextToken(token, nextToken) {
  return token['pos'] == '接頭詞' &&
    token['pos_detail_1'] == '名詞接続' &&
    nextToken != null &&
    nextToken['pos'] == '名詞' ;
}

function repairSmallKanaBoundary(content, chunks) {
  if (!/^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/.test(content) || chunks.length == 0) {
    return content ;
  }

  let previousChunk = chunks[chunks.length - 1] ;
  let previousCharacters = Array.from(previousChunk['text']) ;
  let precedingCharacter = previousCharacters[previousCharacters.length - 1] ;

  if (!/^[ぁ-んァ-ン]$/.test(precedingCharacter)) {
    return content ;
  }

  previousCharacters.pop() ;
  previousChunk['text'] = previousCharacters.join('') ;

  if (previousChunk['text'] == '') {
    chunks.pop() ;
  } else if (/^[ぁ-ん]$/.test(previousChunk['text'])) {
    previousChunk['noLineStart'] = true ;
  }

  return precedingCharacter + content ;
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
  let lineStartToken = firstToken ;

  if (shouldJoinWithNextToken(firstToken, tokens[1])) {
    lineStartToken = tokens[1] ;
  }

  return {
    text: text,
    noLineStart: isNoLineStartToken(lineStartToken, text),
  } ;
}

function isNoLineStartToken(token, text) {
  let surface = text || token['surface_form'] ;

  if (/^[、。，．！？!?）」』】〕）\]\),.]+/.test(surface)) {
    return true ;
  }

  if (/^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/.test(surface)) {
    return true ;
  }

  if (/^[ー々ゝゞヽヾ゛゜]/.test(surface)) {
    return true ;
  }

  if (/^[ぁ-ん]$/.test(surface)) {
    return true ;
  }

  return token['pos'] == '助詞' || token['pos'] == '助動詞' ;
}

module.exports = createSubtitleChunks ;
