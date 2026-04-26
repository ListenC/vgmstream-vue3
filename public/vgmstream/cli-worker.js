// 动态计算 wasmDir 路径，支持不同的部署方式（Web、Electron、Android）
var wasmDir = './'; // 强制安卓用相对路径，不计算复杂URL

var wasmDir = (function() {
  console.log('[Worker] Initializing wasmDir...')
  console.log('[Worker] self.location.href:', self.location.href)
  
  try {
    // 首先尝试使用 self.location.href
    var workerUrl = self.location.href
    
    // 检查是否是 blob URL（开发环境中Worker可能是blob加载的）
    if (workerUrl.startsWith('blob:')) {
      console.log('[Worker] Detected blob: URL, using relative path fallback')
      return './'
    }
    
    // 解析 URL 以获取目录部分
    var url = new URL(workerUrl)
    var pathname = url.pathname
    
    // 移除文件名，获取目录路径
    var lastSlash = pathname.lastIndexOf('/')
    if (lastSlash === -1) {
      console.warn('[Worker] Cannot parse pathname, using relative fallback')
      return './'
    }
    
    var dirPath = pathname.substring(0, lastSlash + 1)
    
    // 构建完整的 WASM 目录 URL
    var result = url.origin + dirPath
    console.log('[Worker] Computed absolute wasmDir:', result)
    return result
  } catch (e) {
    // 任何错误都使用相对路径作为降级方案
    console.warn('[Worker] Failed to compute wasmDir:', e)
    console.log('[Worker] Using relative path: ./')
    return './'
  }
})()

console.log('[Worker] Final wasmDir:', wasmDir)

var stdoutBuffer = ''
var stderrBuffer = ''
var Module = {
  noInitialRun: true,
  locateFile: function(name) {
    var fullPath = wasmDir + name
    console.log('[Worker] Module.locateFile:', name, '->', fullPath)
    return fullPath
  },
  preRun: function() {
    FS.init(undefined, function(code) {
      if (code !== null) stdoutBuffer += String.fromCharCode(code)
    }, function(code) {
      if (code !== null) stderrBuffer += String.fromCharCode(code)
    })
  }
}

function cleanError(error) {
  var output = {
    name: error.name,
    message: error.message,
    stack: error.stack
  }
  for (var key in error) {
    output[key] = error[key]
  }
  return output
}

function writeFile(name, data) {
  var stream = FS.open(name, 'w+')
  FS.write(stream, data, 0, data.length, 0)
  FS.close(stream)
}

function readFile(name) {
  try {
    var stream = FS.open(name, 'r')
  } catch (e) {
    return null
  }
  var data = new Uint8Array(stream.node.usedBytes)
  FS.read(stream, data, 0, data.length, 0)
  FS.close(stream)
  return data
}

function deleteFile(name) {
  try {
    FS.unlink(name)
  } catch (e) {
    // ignore
  }
}

function vgmstream() {
  stdoutBuffer = ''
  stderrBuffer = ''
  var args = Array.prototype.slice.call(arguments)
  try {
    callMain(args)
  } catch (error) {
    error.type = 'wasm'
    throw error
  }
  var output = {
    stdout: stdoutBuffer,
    stderr: stderrBuffer
  }
  stdoutBuffer = ''
  stderrBuffer = ''
  return output
}

function getOutput(output, inputFilename, outputFilename) {
  if (output.error) {
    deleteFile(outputFilename)
    var error = output.error
    error.stdout = output.stdout
    error.stderr = output.stderr
    throw error
  }

  var wavData = readFile(outputFilename)
  if (!wavData) {
    var error = new Error('vgmstream: Unsupported file')
    error.stdout = output.stdout
    error.stderr = output.stderr
    throw error
  }

  deleteFile(outputFilename)
  output.inputFilename = inputFilename
  output.outputFilename = inputFilename + '.wav'
  output.wavData = Array.from(wavData)
  return output
}


function getStreamInfo(data, inputFilename) {
  writeFile(inputFilename, data);

  var output = vgmstream("-I", "-i", inputFilename);

  deleteFile(inputFilename);

  var total = 1;

  // ✅ 优先从 stderr 解析（最可靠）
  var match = (output.stderr || "").match(/stream count:\s*(\d+)/i);
  if (match) {
    total = parseInt(match[1]);
  } else {
    // ⚠️ fallback：再尝试 JSON（不可靠但留着兜底）
    try {
      var lines = output.stdout.trim().split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var obj = JSON.parse(line);
        if (obj.streamInfo && obj.streamInfo.total !== undefined) {
          total = obj.streamInfo.total;
          break;
        }
      }
    } catch (e) {}
  }

  return {
    stdout: output.stdout,
    stderr: output.stderr,
    streamCount: total,
    streamNames: []
  };
}

// 转换单个或多个音频流（每条轨返回完整信息）
function convertFile(data, inputFilename, streamIndices) {
  writeFile(inputFilename, data)
  
  var results = []
  
  if (!streamIndices || streamIndices.length === 0) {
    streamIndices = [0]
  }
  
  //console.log('[Worker] convertFile: streamIndices =', streamIndices)
  
  streamIndices.forEach(function(streamIndex) {
    var outputFilename = '/' + Math.random() + '_stream_' + streamIndex + '_output.wav'
    //console.log('[Worker] Converting stream', streamIndex, 'to', outputFilename)
    try {
      var realTrack = streamIndex + 1;

      // ✅ 正确命令，不动
      var output = vgmstream(
        '-i', inputFilename, 
        '-o', outputFilename, 
        '-s', String(realTrack)
      );

      //console.log('[Worker] vgmstream output for stream', streamIndex, ':', { stdout: output.stdout, stderr: output.stderr })
      var wavData = readFile(outputFilename)
      if (wavData) {
        //console.log('[Worker] Successfully read', wavData.length, 'bytes from', outputFilename)

        results.push({
          streamIndex: streamIndex,
          outputFilename: inputFilename + '_stream_' + streamIndex + '.wav',
          wavData: Array.from(wavData),
          stdout: output.stdout,
          stderr: output.stderr,
        });

        deleteFile(outputFilename)
      } else {
        console.log('[Worker] Failed to read file', outputFilename)
      }
    } catch (e) {
      console.error('Error converting stream ' + streamIndex + ':', e)
    }
  })
  
  deleteFile(inputFilename)
  
  console.log('[Worker] convertFile complete: got', results.length, 'results')
  
  if (results.length === 0) {
    var error = new Error('vgmstream: No streams converted')
    throw error
  }
  
  return {
    success: true,
    results: results,
    totalStreams: results.length
  };
}

async function loadCli() {
  var jsUrl = new URL('./vgmstream-cli.js', self.location.href).href;
  
  console.log('[Worker] Starting to load vgmstream CLI from:', jsUrl)
  console.log('[Worker] Using wasmDir:', wasmDir)
  
  var response
  try {
    response = await fetch(jsUrl)
  } catch (error) {
    console.error('[Worker] Fetch failed for ' + jsUrl, error)
    return errorLoading(jsUrl + ' (Fetch error: ' + error.message + ')')
  }
  
  if (!response.ok) {
    console.error('[Worker] HTTP error loading ' + jsUrl + ': ' + response.status)
    return errorLoading(jsUrl + ' (HTTP ' + response.status + ')')
  }

  console.log('[Worker] Successfully fetched vgmstream-cli.js, evaluating...')
  var cliJs = await response.text()
  try {
    eval.call(null, cliJs)
  } catch (error) {
    console.error('[Worker] Error evaluating vgmstream-cli.js:', error)
    return errorLoading(jsUrl + ' (Eval error: ' + error.message + ')')
  }

  console.log('[Worker] vgmstream-cli.js evaluated successfully, initializing WASM module...')
  try {
    await new Promise(function(resolve, reject) {
      var initTimeout = setTimeout(function() {
        reject(new Error('WASM module initialization timeout (10s)'))
      }, 10000)
      
      Module.onRuntimeInitialized = function() {
        console.log('[Worker] WASM runtime initialized')
        clearTimeout(initTimeout)
        resolve()
      }
      Module.onAbort = function(error) {
        console.error('[Worker] WASM module aborted:', error)
        clearTimeout(initTimeout)
        reject(new Error('WASM module aborted: ' + error))
      }
    })
  } catch (error) {
    console.error('[Worker] WASM module initialization failed:', error)
    return errorLoading(wasmDir + 'vgmstream-cli.wasm (Init error: ' + error.message + ')')
  }

  console.log('[Worker] WASM module initialized successfully, sending load message')
  
  postMessage({ subject: 'load' })
  console.log('[Worker] 发送load完成')
}

function errorLoading(file) {
  console.error('[Worker] Error loading:', file)
  postMessage({ subject: 'load', error: 'Error loading ' + file })
}

async function messageEvent(data) {
  let output = null
  let error = null
  try {
    switch (data.subject) {
      case 'getStreamInfo':
        output = getStreamInfo(data.content[0], data.content[1])
        break
      case 'convertFile':
        output = convertFile(data.content[0], data.content[1], data.content[2])
        break
      default:
        error = new Error('Unknown message subject ' + data.subject)
    }
  } catch (e) {
    error = cleanError(e)
  }

  if (output && output.results) {
    output.results = output.results.map(function(result) {
      return {
        streamIndex: result.streamIndex,
        outputFilename: result.outputFilename,
        wavData: Array.from(result.wavData),
        stdout: result.stdout,
        stderr: result.stderr
      }
    })
  } else if (output && output.wavData) {
    output.wavData = Array.from(output.wavData)
  }

  const message = {
    symbol: data.symbol,
    subject: data.subject,
    content: output,
    error: error ? error : null
  }

  postMessage(message)
}

addEventListener('message', function(event) {
  messageEvent(event.data)
})

loadCli()